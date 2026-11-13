// A small HTTP/1.1 server on Network.framework. It does only what UFTI needs:
// request heads, Content-Length bodies streamed to disk, streamed file responses, and long-lived
// Server-Sent Event responses. One Swift Task serves each connection.
import Foundation
import Network

struct HTTPRequest {
    let method: String
    let path: String               // decoded
    let query: [String: String]
    let headers: [String: String]  // lower-case names
    let remoteIP: String
    let contentLength: Int?
    let chunked: Bool

    var isLoopback: Bool { remoteIP.hasPrefix("127.") || remoteIP == "::1" || remoteIP.hasPrefix("::ffff:127.") }
    func header(_ name: String) -> String? { headers[name.lowercased()] }
    func cookie(_ name: String) -> String? {
        for part in (headers["cookie"] ?? "").split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if kv.count == 2, kv[0] == name { return kv[1] }
        }
        return nil
    }
}

final class HTTPConnection {
    let nw: NWConnection
    private var buffer = Data()
    var keepAlive = true
    var bodyLeft = 0               // bytes of the current request body not read yet
    private var expectContinue = false

    static let common: [String: String] = [
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    ]

    init(_ nw: NWConnection) { self.nw = nw }

    // MARK: raw I/O
    func recv() async -> Data? {
        await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            nw.receive(minimumIncompleteLength: 1, maximumLength: 262_144) { data, _, _, _ in
                if let d = data, !d.isEmpty { c.resume(returning: d) } else { c.resume(returning: nil) }
            }
        }
    }
    @discardableResult
    func send(_ data: Data) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            nw.send(content: data, completion: .contentProcessed { c.resume(returning: $0 == nil) })
        }
    }
    func sendNow(_ data: Data) { nw.send(content: data, completion: .contentProcessed { _ in }) }
    func close() { nw.cancel() }

    // MARK: request
    func readHead() async -> HTTPRequest? {
        let sep = Data("\r\n\r\n".utf8)
        while true {
            if let r = buffer.range(of: sep) {
                let head = String(decoding: buffer.subdata(in: buffer.startIndex..<r.lowerBound), as: UTF8.self)
                buffer = Data(buffer.subdata(in: r.upperBound..<buffer.endIndex))
                guard let req = parse(head) else { return nil }
                bodyLeft = req.contentLength ?? 0
                expectContinue = (req.header("expect") ?? "").lowercased().contains("100-continue")
                return req
            }
            if buffer.count > 65_536 { return nil }
            guard let d = await recv() else { return nil }
            buffer.append(d)
        }
    }

    private func parse(_ head: String) -> HTTPRequest? {
        let lines = head.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ")
        guard first.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for l in lines.dropFirst() {
            guard let i = l.firstIndex(of: ":") else { continue }
            headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        guard let comps = URLComponents(string: "http://x" + String(first[1])) else { return nil }
        var query: [String: String] = [:]
        for q in comps.queryItems ?? [] { query[q.name] = q.value ?? "" }
        var ip = ""
        if case let .hostPort(host, _) = nw.endpoint {
            ip = "\(host)"
            if let pct = ip.firstIndex(of: "%") { ip = String(ip[..<pct]) }
        }
        return HTTPRequest(method: String(first[0]).uppercased(), path: comps.path.isEmpty ? "/" : comps.path,
                           query: query, headers: headers, remoteIP: ip,
                           contentLength: headers["content-length"].flatMap { Int($0) },
                           chunked: (headers["transfer-encoding"] ?? "").lowercased().contains("chunked"))
    }

    private func sendContinueIfNeeded() async {
        if expectContinue && bodyLeft > 0 {
            expectContinue = false
            await send(Data("HTTP/1.1 100 Continue\r\n\r\n".utf8))
        }
    }

    /// Reads up to `max` bytes of the body. Anything beyond stays unread and the connection is closed afterwards.
    func readBody(max: Int) async -> Data? {
        await sendContinueIfNeeded()
        var out = Data()
        let want = min(bodyLeft, max)
        while out.count < want {
            if buffer.isEmpty { guard let d = await recv() else { return nil }; buffer = d }
            let take = min(buffer.count, want - out.count)
            out.append(buffer.prefix(take))
            buffer = Data(buffer.dropFirst(take))
        }
        bodyLeft -= out.count
        return out
    }

    /// Streams the whole body into a file. Returns false if the connection dropped or the write failed.
    func pipeBody(to fh: FileHandle) async -> Bool {
        await sendContinueIfNeeded()
        while bodyLeft > 0 {
            if buffer.isEmpty { guard let d = await recv() else { return false }; buffer = d }
            let take = min(buffer.count, bodyLeft)
            do { try fh.write(contentsOf: take == buffer.count ? buffer : Data(buffer.prefix(take))) } catch { return false }
            buffer = take == buffer.count ? Data() : Data(buffer.dropFirst(take))
            bodyLeft -= take
        }
        return true
    }

    // MARK: response
    @discardableResult
    func sendHead(_ status: Int, _ headers: [String: String] = [:], length: Int?) async -> Bool {
        var h = HTTPConnection.common
        for (k, v) in headers { h[k] = v }
        if let l = length { h["Content-Length"] = String(l) }
        if length == nil { keepAlive = false }
        h["Connection"] = keepAlive ? "keep-alive" : "close"
        var s = "HTTP/1.1 \(status) \(HTTPConnection.reason(status))\r\n"
        for (k, v) in h { s += "\(k): \(v)\r\n" }
        s += "\r\n"
        return await send(Data(s.utf8))
    }

    func respond(_ status: Int, _ headers: [String: String] = [:], _ body: Data = Data()) async {
        guard await sendHead(status, headers, length: body.count) else { return }
        if !body.isEmpty { await send(body) }
    }
    func text(_ status: Int, _ s: String, type: String = "text/plain; charset=utf-8", _ extra: [String: String] = [:]) async {
        var h = extra; h["Content-Type"] = type
        await respond(status, h, Data(s.utf8))
    }
    func json(_ status: Int, _ obj: Any) async {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        await respond(status, ["Content-Type": "application/json"], data)
    }
    func jsonData(_ status: Int, _ data: Data) async { await respond(status, ["Content-Type": "application/json"], data) }

    /// Sends a file in chunks, waiting for each one to leave, so a big file never sits in memory.
    func respondFile(_ url: URL, size: Int, _ headers: [String: String]) async {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return await text(404, "Not found") }
        defer { try? fh.close() }
        guard await sendHead(200, headers, length: size) else { return }
        var left = size
        while left > 0 {
            guard let chunk = try? fh.read(upToCount: min(262_144, left)), !chunk.isEmpty else { close(); return }
            guard await send(chunk) else { return }
            left -= chunk.count
        }
    }

    static func reason(_ s: Int) -> String {
        switch s {
        case 100: return "Continue"; case 200: return "OK"; case 303: return "See Other"
        case 400: return "Bad Request"; case 401: return "Unauthorized"; case 403: return "Forbidden"
        case 404: return "Not Found"; case 411: return "Length Required"; case 415: return "Unsupported Media Type"
        case 421: return "Misdirected Request"; case 429: return "Too Many Requests"; case 500: return "Internal Server Error"
        default: return "OK"
        }
    }
}

final class HTTPServer {
    let port: UInt16
    var handler: ((HTTPRequest, HTTPConnection) async -> Void)?
    private(set) var isReady = false
    var onState: ((String?) -> Void)?   // nil = ready, otherwise an error message
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ufti.http")

    init(port: UInt16) { self.port = port }

    func start() {
        stop()
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let p = NWEndpoint.Port(rawValue: port), let l = try? NWListener(using: params, on: p) else {
            onState?("Could not open port \(port).")
            return
        }
        l.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.isReady = true; self?.onState?(nil)
            case .failed(let e): self?.isReady = false; self?.onState?("Server stopped: \(e)")
            case .cancelled: self?.isReady = false
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] nw in
            guard let self = self else { nw.cancel(); return }
            let conn = HTTPConnection(nw)
            nw.start(queue: self.queue)
            Task { await self.serve(conn) }
        }
        listener = l
        l.start(queue: queue)
    }

    func stop() { listener?.cancel(); listener = nil; isReady = false }

    private func serve(_ conn: HTTPConnection) async {
        while let req = await conn.readHead() {
            conn.keepAlive = (req.header("connection") ?? "").lowercased() != "close"
            await handler?(req, conn)
            if !conn.keepAlive || conn.bodyLeft > 0 { break }
        }
        conn.close()
    }
}
