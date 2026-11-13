import UIKit

/// Puts a file on the iPhone clipboard: images as an image, anything else as a file.
/// Returns "image" or "file", or nil if it could not be copied.
@MainActor
func copyToPasteboard(_ url: URL) -> String? {
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

/// Decides whether a scanned QR code is a UFTI pairing link we are willing to open.
/// It must be http, on a private network address, and carry a pairing code. Anything else is refused,
/// so a QR code from somewhere else can't send the app to an arbitrary website.
enum RemoteLink {
    static func isLocalHost(_ host: String) -> Bool {
        if host.hasSuffix(".local") { return true }
        let p = host.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4, p.allSatisfy({ (0...255).contains($0) }) else { return false }
        return p[0] == 10 || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254)
    }

    static func parse(_ text: String) -> URL? {
        guard let c = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme == "http", let host = c.host, isLocalHost(host),
              c.path.isEmpty || c.path == "/",
              let code = c.queryItems?.first(where: { $0.name == "p" })?.value, !code.isEmpty else { return nil }
        return c.url
    }
}
