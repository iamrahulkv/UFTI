// Addresses this iPhone can be reached on, and the QR image for them. Mirrors netkinds.js.
import Foundation
import UIKit
import CoreImage

struct NetAddr {
    let ip: String
    let name: String
    let kind: String   // "network" or "phone-hotspot"
    let via: String
}

enum Net {
    private static let ranges: [(prefix: String, kind: String, via: String)] = [
        ("172.20.10.", "phone-hotspot", "iPhone hotspot"),   // this iPhone is sharing Personal Hotspot
        ("192.168.43.", "phone-hotspot", "Android hotspot"),
        ("192.168.42.", "phone-hotspot", "Android USB tethering"),
    ]

    static func describe(_ ip: String) -> (kind: String, via: String) {
        if let r = ranges.first(where: { ip.hasPrefix($0.prefix) }) { return (r.kind, r.via) }
        return ("network", "Wi-Fi / network")
    }

    /// IPv4 addresses on Wi-Fi (en*) and the Personal Hotspot bridge (bridge*). Cellular and VPN are skipped.
    static func addresses() -> [NetAddr] {
        var out: [NetAddr] = []
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let i = p.pointee
            guard let sa = i.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let flags = Int32(i.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            let name = String(cString: i.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
            var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: buf)
            if ip.hasPrefix("169.254.") { continue }
            let d = describe(ip)
            out.append(NetAddr(ip: ip, name: name, kind: d.kind, via: d.via))
        }
        return out
    }

    /// PNG of a QR code with a quiet zone, for <img src="/api/qr?u=...">.
    static func qrPNG(_ text: String) -> Data? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f.outputImage else { return nil }
        let scale: CGFloat = 8, margin: CGFloat = 4 * scale
        let img = out.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let area = img.extent.insetBy(dx: -margin, dy: -margin)
        let canvas = img.composited(over: CIImage(color: .white).cropped(to: area))
        guard let cg = CIContext().createCGImage(canvas, from: area) else { return nil }
        return UIImage(cgImage: cg).pngData()
    }
}
