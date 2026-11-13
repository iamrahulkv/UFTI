import SwiftUI
import WebKit

@main
struct UFTIApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ZStack {
                Color(.systemBackground).ignoresSafeArea()
                if let err = model.server.error {
                    VStack(spacing: 10) {
                        Text("UFTI can't start its server").font(.headline)
                        Text(err).font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
                        Button("Try again") { model.server.start() }
                    }.padding()
                } else {
                    WebView(server: model.server)
                }
            }
            .onChange(of: phase) { model.phaseChanged($0) }
        }
    }
}

/// Owns the server. It runs while the app is on screen; iOS suspends background apps, so transfers pause
/// when you leave the app and the screen is kept awake while UFTI is open.
@MainActor
final class AppModel: ObservableObject {
    let server = UFTIServer()
    private var bgTask: UIBackgroundTaskIdentifier = .invalid

    init() { server.start() }

    func phaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            UIApplication.shared.isIdleTimerDisabled = true
            if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
            server.ensureRunning()
        case .background:
            UIApplication.shared.isIdleTimerDisabled = false
            // A little extra time so an upload or download already under way can finish.
            bgTask = UIApplication.shared.beginBackgroundTask { [weak self] in
                guard let self = self else { return }
                UIApplication.shared.endBackgroundTask(self.bgTask); self.bgTask = .invalid
            }
        default: break
        }
    }
}

/// The same page the Windows app shows, loaded from the embedded server and signed in as "This iPhone".
struct WebView: UIViewRepresentable {
    let server: UFTIServer

    func makeCoordinator() -> Coordinator { Coordinator(server) }

    func makeUIView(context: Context) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        wv.navigationDelegate = context.coordinator
        wv.isOpaque = false
        wv.backgroundColor = .clear
        context.coordinator.webView = wv
        wv.configuration.websiteDataStore.httpCookieStore.setCookie(server.localCookie()) { context.coordinator.load() }
        return wv
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let server: UFTIServer
        weak var webView: WKWebView?
        private var retries = 0
        private let home = URL(string: "http://localhost:\(UFTIServer.port)/")!

        init(_ server: UFTIServer) { self.server = server }

        func load() { webView?.load(URLRequest(url: home)) }

        // The listener may need a moment after launch; try again a few times.
        func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
            guard retries < 20 else { return }
            retries += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.server.ensureRunning(); self?.load() }
        }

        func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            // "Save" on a received file: hand the file to the iOS share sheet (Save to Files, Photos, AirDrop...).
            if url.host == "localhost", url.path.hasPrefix("/api/file/") {
                let id = String(url.path.dropFirst("/api/file/".count))
                if let item = server.store.find(id), item.kind == "file" { share(server.store.fileURL(item), from: w) }
                return decisionHandler(.cancel)
            }
            // Real web links open in Safari, not inside the app.
            if let scheme = url.scheme, scheme.hasPrefix("http"), url.host != "localhost", action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
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
