// The UFTI backend, ported from server.js. Same routes, same JSON, so public/index.html runs unchanged
// both here (inside the app) and in a phone's browser (after it scans the QR code).
import Foundation
import UIKit

final class UFTIServer: ObservableObject {
    static let port: UInt16 = 8787

    @Published var error: String?          // nil while the listener is healthy

    let auth: Auth
    let store: Store
    let http = HTTPServer(port: UFTIServer.port)

    private let lock = NSLock()
    private var streams: [UUID: (conn: HTTPConnection, sid: String)] = [:]
    private var preferredIp = ""
    private var pingTimer: DispatchSourceTimer?
    private let publicDir: URL

    init() {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("UFTI", isDirectory: true)
        try? fm.createDirectory(at: support, withIntermediateDirectories: true)
        auth = Auth(dataDir: support)
        store = Store(documents: docs, support: support)
        publicDir = (Bundle.main.resourceURL ?? URL(fileURLWithPath: "/")).appendingPathComponent("public", isDirectory: true).standardizedFileURL
        store.emit = { [weak self] in self?.broadcast($0) }
        http.handler = { [weak self] req, conn in await self?.handle(req, conn) }
        http.onState = { [weak self] msg in DispatchQueue.main.async { self?.error = msg } }
    }

    func start() {
        http.start()
        guard pingTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now() + 20, repeating: 20)
        t.setEventHandler { [weak self] in self?.broadcastRaw(": ping\n\n") }
        t.resume()
        pingTimer = t
    }
    /// iOS closes listeners while the app is suspended; call this when it comes back.
    func ensureRunning() { if !http.isReady { http.start() } }

    /// The cookie that signs the in-app web view in as "this iPhone". Kept between launches.
    func localCookie() -> HTTPCookie {
        let key = "localSecret"
        var secret = UserDefaults.standard.string(forKey: key)
        if secret == nil || auth.lookup(secret)?.kind != "device" {
            secret = auth.create("device", "This iPhone").secret
            UserDefaults.standard.set(secret, forKey: key)
        }
        return HTTPCookie(properties: [.name: Auth.cookieName, .value: secret!, .domain: "localhost", .path: "/",
                                       .expires: Date(timeIntervalSinceNow: 365 * 86400)])!
    }

    // MARK: live updates
    private func broadcast(_ json: String) { broadcastRaw("data: \(json)\n\n") }
    private func broadcastRaw(_ s: String) {
        lock.lock(); let list = streams.values.map { $0.conn }; lock.unlock()
        let d = Data(s.utf8)
        for c in list { c.sendNow(d) }
    }
    private func closeStreams(_ sid: String) {
        lock.lock(); let gone = streams.filter { $0.value.sid == sid }; for k in gone.keys { streams[k] = nil }; lock.unlock()
        for v in gone.values { v.conn.close() }
    }

    // MARK: helpers
    private func lanIPs() -> [String] {
        let ips = Net.addresses().map { $0.ip }.sorted { ($0.hasPrefix("192.168.") ? 0 : 1) < ($1.hasPrefix("192.168.") ? 0 : 1) }
        if !preferredIp.isEmpty && ips.contains(preferredIp) { return [preferredIp] + ips.filter { $0 != preferredIp } }
        return ips
    }
    private func pairURL(_ ip: String) -> String { "http://\(ip):\(UFTIServer.port)/?p=\(auth.currentPairing().code)" }

    private func cleanName(_ raw: String) -> String {
        let base = (raw as NSString).lastPathComponent
        let bad = CharacterSet(charactersIn: "<>:\"/\\|?*").union(.controlCharacters)
        let s = base.unicodeScalars.map { bad.contains($0) ? "_" : String($0) }.joined()
        return s.isEmpty ? "file" : s
    }
    private func hexID() -> String { (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }
    private func isHexID(_ s: String) -> Bool { s.count == 8 && s.allSatisfy { $0.isHexDigit } }
    private func hostIsLocal(_ h: String?) -> Bool {
        guard var host = h?.lowercased() else { return false }
        if let c = host.lastIndex(of: ":"), !host.hasSuffix("]") { host = String(host[..<c]) }
        return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
    }
    private func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    private static let uriSafe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    private static let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript", "css": "text/css",
                               "json": "application/json", "webmanifest": "application/manifest+json",
                               "svg": "image/svg+xml", "png": "image/png"]

    private func page(_ c: HTTPConnection, _ status: Int, _ title: String, _ body: String) async {
        let css = "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F2F5FB;color:#10213F;font:16px/1.4 -apple-system,system-ui,sans-serif}" +
            "@media(prefers-color-scheme:dark){body{background:#071226;color:#EAF0FF}.c{background:#0F2145!important;border-color:#1F3568!important}}" +
            ".c{max-width:340px;margin:16px;padding:22px;border:1px solid #DCE3F0;border-radius:16px;background:#fff;border-top:4px solid #F58220}" +
            "h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#5A6B88}"
        await c.text(status, "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>UFTI</title><style>\(css)</style><div class=\"c\"><h1>\(esc(title))</h1>\(body)</div>",
                     type: "text/html; charset=utf-8")
    }

    private static let hotspotNote = "An app can't start the iPhone hotspot. Turn on Personal Hotspot in Settings, then use the Phone hotspot tab."

    // MARK: routing
    private func handle(_ req: HTTPRequest, _ c: HTTPConnection) async {
        let loop = req.isLoopback
        let ip = req.remoteIP
        let p = req.path

        // Requests from the phone itself must be addressed to localhost (guards against DNS rebinding).
        if loop && !hostIsLocal(req.header("host")) { return await c.text(421, "Misdirected request") }

        // Pairing: the one-time code in the QR link becomes a session cookie, then the address is cleaned.
        if req.method == "GET", p == "/", let code = req.query["p"] {
            let wait = auth.blockedFor(ip)
            if wait > 0 { return await c.text(429, "Too many attempts. Try again in \(wait) seconds.", ["Retry-After": String(wait)]) }
            guard auth.peek(code), let r = auth.consume(code, userAgent: req.header("user-agent") ?? "") else {
                auth.fail(ip)
                return await page(c, 403, "Pairing link expired", "<p>This link was already used or has expired. Scan the QR code in the UFTI app on the iPhone again.</p>")
            }
            return await c.respond(303, ["Set-Cookie": auth.cookieHeader(r.secret), "Location": "/"])
        }

        // The page and its icons are public; everything useful sits behind the API.
        if req.method == "GET", !p.hasPrefix("/api/") { return await serveStatic(p, c) }

        // API: needs a paired device (cookie) or a share key.
        let wait = auth.blockedFor(ip)
        if wait > 0 { return await c.text(429, "Too many attempts. Try again in \(wait) seconds.", ["Retry-After": String(wait)]) }
        let a = auth.authenticate(cookie: req.cookie(Auth.cookieName), key: req.header("x-token") ?? req.query["t"])
        guard let session = a.session else {
            if a.presented { auth.fail(ip) }
            return await c.json(401, ["error": "not paired"])
        }
        let viaKey = a.via == "key"
        if viaKey && !(req.method == "POST" && (p == "/api/upload" || p == "/api/text")) {
            return await c.json(403, ["error": "share keys can only send files and text"])
        }
        if !viaKey && req.method != "GET" && req.method != "HEAD" { // CSRF: changes must come from our own page
            var badOrigin = false
            if let origin = req.header("origin") {
                let originHost = URL(string: origin).flatMap { u in u.host.map { h in u.port.map { "\(h):\($0)" } ?? h } }
                badOrigin = originHost != req.header("host")
            }
            if badOrigin || req.header("sec-fetch-site") == "cross-site" { return await c.json(403, ["error": "cross-site request refused"]) }
        }
        let sid = session.h
        let pcOnly = loop && !viaKey

        // Live updates (Server-Sent Events). The connection stays open until the page goes away.
        if req.method == "GET", p == "/api/events" {
            c.keepAlive = false
            guard await c.sendHead(200, ["Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
                                         "X-Accel-Buffering": "no"], length: nil) else { return }
            await c.send(Data("retry: 2000\n\n".utf8))
            let id = UUID()
            lock.lock(); streams[id] = (c, sid); lock.unlock()
            while await c.recv() != nil {}
            lock.lock(); streams[id] = nil; lock.unlock()
            return
        }

        // In-app window only: connection, hotspot, firewall, pairing, paired devices and share keys.
        if ["/api/network", "/api/network/select", "/api/hotspot", "/api/firewall", "/api/pairing", "/api/devices", "/api/keys"].contains(p)
            || p.hasPrefix("/api/devices/") || p.hasPrefix("/api/copy/") {
            guard pcOnly else { return await c.json(403, ["error": "only available in the UFTI app on the iPhone"]) }
            return await handleLocal(req, c, sid: sid)
        }

        if req.method == "GET", p == "/api/info" {
            struct Me: Encodable { let id: String; let name: String }
            struct Info: Encodable { let items: [Item]; let host: String; let me: Me }
            let info = Info(items: store.all(), host: "iPhone", me: Me(id: String(sid.prefix(12)), name: session.name))
            return await c.jsonData(200, (try? JSONEncoder().encode(info)) ?? Data())
        }

        if req.method == "GET", p == "/api/qr" {
            guard let png = Net.qrPNG(req.query["u"] ?? "") else { return await c.text(500, "qr failed") }
            return await c.respond(200, ["Content-Type": "image/png"], png)
        }

        if req.method == "POST", p == "/api/upload" { return await handleUpload(req, c) }

        if req.method == "POST", p == "/api/text" {
            guard let body = await c.readBody(max: 1_000_000) else { return }
            var text = String(decoding: body, as: UTF8.self)
            var from = req.header("x-device") ?? req.query["device"]
            var fromId = req.header("x-client") ?? req.query["client"] ?? ""
            if let j = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let t = j["text"] as? String {
                text = t
                if let f = j["from"] as? String, !f.isEmpty { from = f }
                if let f = j["fromId"] as? String, !f.isEmpty { fromId = f }
            }
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return await c.json(400, ["error": "empty"]) }
            let item = Item(id: hexID(), kind: "text", name: nil, size: nil, text: String(text.prefix(100_000)),
                            from: from ?? "device", fromId: fromId, ts: Int64(Date().timeIntervalSince1970 * 1000))
            store.add(item)
            return await c.jsonData(200, (try? JSONEncoder().encode(item)) ?? Data())
        }

        if req.method == "GET", p.hasPrefix("/api/file/") {
            let id = String(p.dropFirst("/api/file/".count))
            guard isHexID(id), let item = store.find(id), item.kind == "file" else { return await c.text(404, "") }
            let encoded = (item.name ?? "file").addingPercentEncoding(withAllowedCharacters: UFTIServer.uriSafe) ?? "file"
            return await c.respondFile(store.fileURL(item), size: Int(item.size ?? 0), [
                "Content-Type": "application/octet-stream",
                "Content-Disposition": "attachment; filename*=UTF-8''" + encoded,
            ])
        }

        if req.method == "DELETE", p.hasPrefix("/api/item/") {
            let id = String(p.dropFirst("/api/item/".count))
            if store.remove(id, deleteFile: true) { return await c.json(200, ["ok": true]) }
            return await c.json(404, ["error": "gone"])
        }

        // Clear history entries. Body: { ids: [...], deleteFiles: bool }. Omit ids to clear everything.
        if req.method == "POST", p == "/api/clear" {
            let body = await c.readBody(max: 1_000_000) ?? Data()
            let opts = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            let ids = (opts["ids"] as? [String]) ?? store.all().map { $0.id }
            let del = (opts["deleteFiles"] as? Bool) ?? false
            var removed = 0
            for id in ids where store.remove(id, deleteFile: del) { removed += 1 }
            return await c.json(200, ["removed": removed])
        }

        await c.json(404, ["error": "unknown route"])
    }

    private func serveStatic(_ path: String, _ c: HTTPConnection) async {
        let rel = path == "/" ? "index.html" : String(path.dropFirst())
        let file = publicDir.appendingPathComponent(rel).standardizedFileURL
        var isDir: ObjCBool = false
        guard file.path.hasPrefix(publicDir.path + "/"), FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir),
              !isDir.boolValue, var data = try? Data(contentsOf: file) else { return await c.text(404, "Not found") }
        // Tell the shared page it is hosted by an iPhone, so it hides the PC-only options and wording.
        if rel == "index.html", var html = String(data: data, encoding: .utf8), let r = html.range(of: "<head>") {
            html.replaceSubrange(r, with: "<head>\n<script>window.UFTI_HOST = 'ios';</script>")
            data = Data(html.utf8)
        }
        await c.respond(200, ["Content-Type": UFTIServer.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"], data)
    }

    private func handleUpload(_ req: HTTPRequest, _ c: HTTPConnection) async {
        let device = req.header("x-device") ?? req.query["device"] ?? "device"
        let client = req.header("x-client") ?? req.query["client"] ?? ""
        if (req.header("content-type") ?? "").lowercased().hasPrefix("multipart/form-data") {
            return await c.json(415, ["error": "multipart uploads are not supported by the iPhone app yet; send the raw file body"])
        }
        guard !req.chunked, req.contentLength != nil else { return await c.json(411, ["error": "Content-Length required"]) }
        var raw = req.header("x-filename") ?? req.query["name"] ?? "file"
        raw = raw.removingPercentEncoding ?? raw
        let name = cleanName(raw), id = hexID()
        let dest = store.dir.appendingPathComponent("\(id)__\(name)")
        FileManager.default.createFile(atPath: dest.path, contents: nil)
        guard let fh = try? FileHandle(forWritingTo: dest) else { return await c.json(500, ["error": "write failed"]) }
        let ok = await c.pipeBody(to: fh)
        try? fh.close()
        guard ok else { try? FileManager.default.removeItem(at: dest); return } // client went away mid-upload
        let size = ((try? FileManager.default.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber)?.int64Value ?? 0
        let item = Item(id: id, kind: "file", name: name, size: size, text: nil, from: device, fromId: client,
                        ts: Int64(Date().timeIntervalSince1970 * 1000))
        store.add(item)
        await c.jsonData(200, (try? JSONEncoder().encode(item)) ?? Data())
    }

    /// Routes that only the app's own window may use.
    private func handleLocal(_ req: HTTPRequest, _ c: HTTPConnection, sid: String) async {
        let p = req.path
        if req.method == "GET", p == "/api/network" {
            let pr = auth.currentPairing()
            let addresses = Net.addresses().map { ["ip": $0.ip, "name": $0.name, "kind": $0.kind, "via": $0.via, "url": pairURL($0.ip)] }
            return await c.json(200, ["port": Int(UFTIServer.port), "preferred": lanIPs().first ?? "", "addresses": addresses,
                                      "expires": pr.expires, "firewall": true] as [String: Any])
        }
        if req.method == "POST", p == "/api/network/select" {
            let body = await c.readBody(max: 10_000) ?? Data()
            let want = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["ip"] as? String ?? ""
            guard Net.addresses().contains(where: { $0.ip == want }) else { return await c.json(400, ["error": "unknown address"]) }
            preferredIp = want
            return await c.json(200, ["ok": true])
        }
        if req.method == "GET", p == "/api/pairing" {
            let pr = auth.currentPairing()
            return await c.json(200, ["code": pr.code, "expires": pr.expires] as [String: Any])
        }
        if req.method == "GET", p == "/api/devices" {
            let devices = auth.list().map { ["id": $0.id, "kind": $0.kind, "name": $0.name, "created": $0.created,
                                             "lastSeen": $0.lastSeen, "current": $0.id == String(sid.prefix(12))] as [String: Any] }
            return await c.json(200, ["devices": devices])
        }
        if req.method == "DELETE", p.hasPrefix("/api/devices/") {
            guard let gone = auth.revoke(String(p.dropFirst("/api/devices/".count))) else { return await c.json(404, ["error": "not found"]) }
            closeStreams(gone.h)
            return await c.json(200, ["ok": true])
        }
        if req.method == "POST", p == "/api/keys" {
            let body = await c.readBody(max: 10_000) ?? Data()
            let name = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["name"] as? String ?? ""
            let k = auth.create("key", name.isEmpty ? "Share key" : name)
            return await c.json(200, ["key": k.secret, "id": k.session.id, "name": k.session.name])
        }
        if p == "/api/hotspot" {
            if req.method == "GET" { return await c.json(200, ["supported": false, "state": "Off", "error": UFTIServer.hotspotNote] as [String: Any]) }
            return await c.json(200, ["ok": false, "error": UFTIServer.hotspotNote] as [String: Any])
        }
        if req.method == "POST", p == "/api/firewall" { return await c.json(200, ["ok": true]) }
        // Copy a received file to the iPhone clipboard: images as an image, anything else as a file.
        if req.method == "POST", p.hasPrefix("/api/copy/") {
            let id = String(p.dropFirst("/api/copy/".count))
            guard isHexID(id), let item = store.find(id), item.kind == "file" else { return await c.json(404, ["error": "gone"]) }
            let url = store.fileURL(item)
            let kind: String? = await MainActor.run {
                let board = UIPasteboard.general
                if ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tiff"].contains(url.pathExtension.lowercased()),
                   let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                    board.image = image
                    return "image"
                }
                if let provider = NSItemProvider(contentsOf: url) {
                    board.setItemProviders([provider], localOnly: false, expirationDate: nil)
                    return "file"
                }
                return nil
            }
            guard let kind = kind else { return await c.json(500, ["error": "could not copy this file"]) }
            return await c.json(200, ["ok": true, "as": kind])
        }
        await c.json(404, ["error": "unknown route"])
    }
}
