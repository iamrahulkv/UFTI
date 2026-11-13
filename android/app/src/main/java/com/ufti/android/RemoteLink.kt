package com.ufti.android

import java.net.URI

/**
 * Decides whether a scanned QR code is a UFTI pairing link we are willing to open. It must be http, on a private network
 * address, and carry a pairing code. Anything else is refused, so a QR code from somewhere else can't send the app to an
 * arbitrary website. Same rules as the iPhone app (Helpers.swift), so both apps accept the same links.
 */
class RemoteLink(val start: String, val base: String, val host: String) {
    companion object {
        fun isLocalHost(host: String): Boolean {
            if (host.endsWith(".local")) return true
            val p = host.split('.').map { it.toIntOrNull() ?: return false }
            if (p.size != 4 || p.any { it !in 0..255 }) return false
            return p[0] == 10 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254)
        }

        fun parse(text: String): RemoteLink? {
            val u = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            val host = u.host ?: return null
            if (u.scheme != "http" || !isLocalHost(host)) return null
            if (!(u.rawPath.isNullOrEmpty() || u.rawPath == "/")) return null
            val code = (u.rawQuery ?: "").split('&').firstOrNull { it.startsWith("p=") }?.substring(2)
            if (code.isNullOrEmpty()) return null
            val hostPort = if (u.port >= 0) "$host:${u.port}" else host
            return RemoteLink(u.toString(), "http://$hostPort/", host)
        }
    }
}
