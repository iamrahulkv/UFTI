// Port of auth.js: one-time pairing codes, per-device sessions, share keys, rate limiting.
// Only SHA-256 hashes of sessions and keys are written to disk.
import Foundation
import CryptoKit

final class Auth {
    struct Session: Codable {
        var h: String            // hash of the secret
        var kind: String         // "device" or "key"
        var name: String
        var created: Int64
        var lastSeen: Int64
        var id: String { String(h.prefix(12)) }
    }
    struct Result { let session: Session?; let via: String; let presented: Bool }

    static let cookieName = "ufti_session"
    private let pairTTL: Int64 = 5 * 60 * 1000
    private let pairRefresh: Int64 = 60 * 1000
    private let limitWindow: Int64 = 60 * 1000, limitMax = 20, limitBlock: Int64 = 60 * 1000

    private let lock = NSLock()
    private let file: URL
    private var sessions: [String: Session] = [:]
    private var pairing: (code: String, expires: Int64, used: Bool)?
    private var fails: [String: (start: Int64, count: Int, blockedUntil: Int64)] = [:]

    init(dataDir: URL) {
        file = dataDir.appendingPathComponent("sessions.json")
        if let d = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([Session].self, from: d) {
            for s in list { sessions[s.h] = s }
        }
    }

    private func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private func save() { // caller holds the lock
        if let d = try? JSONEncoder().encode(Array(sessions.values)) { try? d.write(to: file, options: .atomic) }
    }

    static func sha(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
    static func secret(prefix: String = "") -> String {
        var b = [UInt8](repeating: 0, count: 16) // 128 bits
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        let s = Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return prefix + s
    }
    private func same(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var d: UInt8 = 0
        for i in 0..<x.count { d |= x[i] ^ y[i] }
        return d == 0
    }

    static func deviceName(_ ua: String) -> String {
        let os = ua.contains("iPhone") ? "iPhone" : ua.contains("iPad") ? "iPad" : ua.contains("Android") ? "Android"
            : ua.contains("Windows") ? "Windows PC" : ua.contains("Mac") ? "Mac" : ua.contains("Linux") ? "Linux" : "Device"
        let browser = ua.contains("Edg/") ? "Edge" : ua.contains("OPR/") ? "Opera" : ua.contains("SamsungBrowser") ? "Samsung Internet"
            : (ua.contains("Firefox") || ua.contains("FxiOS")) ? "Firefox" : (ua.contains("CriOS") || ua.contains("Chrome")) ? "Chrome"
            : ua.contains("Safari") ? "Safari" : ""
        return browser.isEmpty ? os : "\(os) · \(browser)"
    }

    // MARK: sessions and share keys
    func create(_ kind: String, _ name: String) -> (secret: String, session: Session) {
        lock.lock(); defer { lock.unlock() }
        let value = Auth.secret(prefix: kind == "key" ? "uk_" : "")
        let s = Session(h: Auth.sha(value), kind: kind, name: String((name.isEmpty ? "Device" : name).prefix(60)),
                        created: now(), lastSeen: now())
        sessions[s.h] = s
        save()
        return (value, s)
    }
    func lookup(_ value: String?) -> Session? {
        guard let value = value, !value.isEmpty else { return nil }
        lock.lock(); defer { lock.unlock() }
        guard var s = sessions[Auth.sha(value)] else { return nil }
        if now() - s.lastSeen > 60_000 { s.lastSeen = now(); sessions[s.h] = s; save() } // touch at most once a minute
        return s
    }
    func list() -> [Session] {
        lock.lock(); defer { lock.unlock() }
        return sessions.values.sorted { $0.lastSeen > $1.lastSeen }
    }
    func revoke(_ id: String) -> Session? {
        lock.lock(); defer { lock.unlock() }
        guard let s = sessions.values.first(where: { $0.id == id }) else { return nil }
        sessions[s.h] = nil
        save()
        return s
    }

    /// Cookie (browsers) or share key (tools). `presented` says whether credentials were sent at all,
    /// so only wrong credentials count as failed attempts.
    func authenticate(cookie: String?, key: String?) -> Result {
        let k = key ?? ""
        if (cookie ?? "").isEmpty && k.isEmpty { return Result(session: nil, via: "", presented: false) }
        if let s = lookup(cookie), s.kind == "device" { return Result(session: s, via: "cookie", presented: true) }
        if let s = lookup(k), s.kind == "key" { return Result(session: s, via: "key", presented: true) }
        return Result(session: nil, via: "", presented: true)
    }

    // MARK: one-time pairing codes
    func currentPairing() -> (code: String, expires: Int64) {
        lock.lock(); defer { lock.unlock() }
        if pairing == nil || pairing!.used || pairing!.expires - now() < pairRefresh {
            pairing = (Auth.secret(), now() + pairTTL, false)
        }
        return (pairing!.code, pairing!.expires)
    }
    /// Is this code still usable? Does not use it up.
    func peek(_ code: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let p = pairing else { return false }
        return same(p.code, code) && !p.used && p.expires > now()
    }
    /// Uses the code up and creates the device session.
    func consume(_ code: String, userAgent: String) -> (secret: String, session: Session)? {
        lock.lock()
        guard let p = pairing, same(p.code, code), !p.used, p.expires > now() else { lock.unlock(); return nil }
        pairing!.used = true
        lock.unlock()
        return create("device", Auth.deviceName(userAgent))
    }

    // MARK: rate limiting of failed attempts, per client address
    func blockedFor(_ ip: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard let f = fails[ip], f.blockedUntil > now() else { return 0 }
        return Int((f.blockedUntil - now() + 999) / 1000)
    }
    func fail(_ ip: String) {
        lock.lock(); defer { lock.unlock() }
        var f = fails[ip] ?? (now(), 0, 0)
        if now() - f.start > limitWindow { f = (now(), 0, 0) }
        f.count += 1
        if f.count > limitMax { f.blockedUntil = now() + limitBlock }
        fails[ip] = f
        if fails.count > 1000 { fails = fails.filter { now() - $0.value.start <= limitWindow || $0.value.blockedUntil >= now() } }
    }

    func cookieHeader(_ value: String) -> String {
        "\(Auth.cookieName)=\(value); Path=/; HttpOnly; SameSite=Strict; Max-Age=\(365 * 24 * 60 * 60)"
    }
}
