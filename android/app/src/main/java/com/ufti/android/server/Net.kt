package com.ufti.android.server

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.net.Inet4Address
import java.net.NetworkInterface

data class NetAddr(val ip: String, val name: String, val kind: String, val via: String)

/** Addresses this phone can be reached on (mirrors netkinds.js), and the QR image for them. */
object Net {
    private val ranges = listOf(
        Triple("172.20.10.", "phone-hotspot", "iPhone hotspot"),
        Triple("192.168.43.", "phone-hotspot", "Android hotspot"),
        Triple("192.168.42.", "phone-hotspot", "Android USB tethering"),
    )

    fun describe(ip: String, ifName: String = ""): Pair<String, String> {
        // When this phone shares its own hotspot, the access-point interface carries the address.
        if (ifName.startsWith("ap") || ifName.startsWith("swlan")) return "phone-hotspot" to "This phone's hotspot"
        if (ifName.startsWith("rndis") || ifName.startsWith("usb")) return "phone-hotspot" to "USB tethering"
        ranges.firstOrNull { ip.startsWith(it.first) }?.let { return it.second to it.third }
        return "network" to "Wi-Fi / network"
    }

    /** IPv4 addresses on Wi-Fi, the hotspot and USB tethering. Mobile data and VPNs are skipped. */
    fun addresses(): List<NetAddr> {
        val out = ArrayList<NetAddr>()
        val ifs = runCatching { NetworkInterface.getNetworkInterfaces()?.toList() }.getOrNull().orEmpty()
        for (i in ifs) {
            if (!runCatching { i.isUp && !i.isLoopback }.getOrDefault(false)) continue
            val n = i.name
            if (!(n.startsWith("wlan") || n.startsWith("ap") || n.startsWith("swlan") || n.startsWith("eth") ||
                    n.startsWith("rndis") || n.startsWith("usb"))) continue
            for (a in i.inetAddresses) {
                if (a !is Inet4Address || a.isLinkLocalAddress) continue
                val ip = a.hostAddress ?: continue
                val (kind, via) = describe(ip, n)
                out.add(NetAddr(ip, n, kind, via))
            }
        }
        return out
    }

    /** SVG QR code with a quiet zone, for <img src="/api/qr?u=...">. Plain text, so no image library is needed. */
    fun qrSvg(text: String): String? = runCatching {
        val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 4,
            EncodeHintType.CHARACTER_SET to "UTF-8")
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
        val path = StringBuilder()
        for (y in 0 until m.height) {
            var x = 0
            while (x < m.width) {
                if (!m.get(x, y)) { x++; continue }
                var e = x
                while (e < m.width && m.get(e, y)) e++
                path.append("M$x,${y}h${e - x}v1h-${e - x}z")
                x = e
            }
        }
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 ${m.width} ${m.height}\" shape-rendering=\"crispEdges\">" +
            "<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/><path d=\"$path\" fill=\"#000\"/></svg>"
    }.getOrNull()
}
