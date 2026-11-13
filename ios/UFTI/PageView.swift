// The web view. In host mode it shows this iPhone's own UFTI page (localhost). In client mode it shows the page
// served by another UFTI (the Windows app or another iPhone), after the QR scan paired this iPhone with it.
import SwiftUI
import WebKit

struct PageView: UIViewRepresentable {
    let model: AppModel
    let start: URL
    let isClient: Bool

    func makeCoordinator() -> Coordinator { Coordinator(model: model, start: start, isClient: isClient) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // Native Copy for client mode: the page posts a file id and the app downloads the file and sets the clipboard.
        if isClient { cfg.userContentController.add(context.coordinator, name: "uftiCopy") }
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.isOpaque = false
        wv.backgroundColor = .clear
        context.coordinator.webView = wv
        if isClient {
            context.coordinator.load()
        } else {
            // Host mode: sign the page in as "This iPhone" before loading it.
            wv.configuration.websiteDataStore.httpCookieStore.setCookie(model.server.localCookie()) { context.coordinator.load() }
        }
        return wv
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "uftiCopy")
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let model: AppModel
        let start: URL
        let isClient: Bool
        weak var webView: WKWebView?
        private var retries = 0

        init(model: AppModel, start: URL, isClient: Bool) {
            self.model = model; self.start = start; self.isClient = isClient
        }

        func load() { webView?.load(URLRequest(url: start)) }

        /// The host this page belongs to: localhost, or the PC / phone we scanned.
        private var ownHost: String? { isClient ? model.remoteBase?.host : "localhost" }

        func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
            if isClient { model.pairingConsumed() }
        }

        func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
            let ns = e as NSError
            if ns.code == NSURLErrorCancelled || ns.domain == "WebKitErrorDomain" { return } // our own cancelled navigations
            if isClient {
                model.alert = "Couldn't reach \(model.remoteBase?.host ?? "the other device"). Make sure both devices are on the same Wi-Fi and UFTI is open there."
                return
            }
            // Host mode: the listener may need a moment after launch; try again a few times.
            guard retries < 20 else { return }
            retries += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
                self?.model.server.ensureRunning()
                self?.load()
            }
        }

        func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            // "Save" on a received file: get the file, then hand it to the iOS share sheet (Save to Files, Photos, AirDrop...).
            if url.host == ownHost, url.path.hasPrefix("/api/file/") {
                let id = String(url.path.dropFirst("/api/file/".count))
                if isClient {
                    Task { await saveRemote(id, from: w) }
                } else if let item = model.server.store.find(id), item.kind == "file" {
                    share(model.server.store.fileURL(item), from: w)
                }
                return decisionHandler(.cancel)
            }
            // Real web links open in Safari, not inside the app.
            if let scheme = url.scheme, scheme.hasPrefix("http"), url.host != ownHost, action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        // MARK: client mode: native download, Save and Copy

        /// Downloads a received file from the other device, signed in with the page's own cookie.
        private func download(_ id: String) async throws -> URL {
            guard let w = webView, let base = model.remoteBase, let host = base.host,
                  var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
            comps.path = "/api/file/\(id)"
            guard let url = comps.url else { throw URLError(.badURL) }
            let cookies = await w.configuration.websiteDataStore.httpCookieStore.allCookies()
                .filter { $0.domain == host || $0.domain == "." + host }
            var req = URLRequest(url: url)
            for (k, v) in HTTPCookie.requestHeaderFields(with: cookies) { req.setValue(v, forHTTPHeaderField: k) }
            let (tmp, resp) = try await URLSession.shared.download(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("UFTI-dl", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(Coordinator.filename(from: resp))
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        }

        static func filename(from resp: URLResponse) -> String {
            if let h = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition"),
               let r = h.range(of: "filename*=UTF-8''"),
               let name = String(h[r.upperBound...]).components(separatedBy: ";").first?.removingPercentEncoding, !name.isEmpty {
                let safe = (name as NSString).lastPathComponent
                if !safe.isEmpty && safe != ".." { return safe }
            }
            return resp.suggestedFilename ?? "file"
        }

        private func saveRemote(_ id: String, from w: WKWebView) async {
            guard id.count == 8 else { return }
            model.busy = "Downloading…"
            defer { model.busy = nil }
            do { share(try await download(id), from: w) }
            catch { model.alert = "Couldn't download the file." }
        }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let id = message.body as? String, id.count == 8, id.allSatisfy({ $0.isHexDigit }) else { return }
            Task {
                model.busy = "Copying…"
                defer { model.busy = nil }
                var msg = "Could not copy. Use Save."
                if let file = try? await download(id), let kind = copyToPasteboard(file) {
                    msg = kind == "image" ? "Image copied. Paste it anywhere." : "File copied. Paste it into a chat or Files."
                }
                webView?.evaluateJavaScript("toast(\"\(msg)\")")
            }
        }

        private func share(_ file: URL, from view: UIView) {
            let vc = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            vc.popoverPresentationController?.sourceView = view
            vc.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            var top = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }.first { $0.isKeyWindow }?.rootViewController
            while let next = top?.presentedViewController { top = next }
            top?.present(vc, animated: true)
        }
    }
}
