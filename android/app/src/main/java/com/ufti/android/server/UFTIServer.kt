package com.ufti.android.server

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The UFTI backend for Android, ported from server.js and the iPhone app's UFTIServer.swift.
 * Same routes, same JSON, so public/index.html runs unchanged inside the app and in any browser that scans the QR code,
 * and the Windows app, the iPhone app and this app can all pair with each other.
 *
 * Nothing here touches the Android SDK (besides org.json), so it is unit-tested on the plain JVM.
 */
class UFTIServer(
    port: Int,
    dataDir: File,
    receivedDir: File,
    private val hostName: String,
    /** Reads a bundled web asset, e.g. "public/index.html". Null if missing. */
    private val asset: (String) -> ByteArray?,
    /** Copies a received file to the system clipboard. Returns "image" or "file", or null on failure. */
    var copyHandler: ((File) -> String?)? = null,
    /** Lists the phone's addresses; replaceable in tests. */
    private val addresses: () -> List<NetAddr> = { Net.addresses() },
) {
    val auth = Auth(dataDir)
    val store = Store(receivedDir, File(dataDir, "history.json"))
    private val http = HttpServer(port)

    private class Stream(val conn: HttpConnection, val sid: String) {
        val queue = LinkedBlockingQueue<ByteArray>()
        @Volatile var closed = false
    }
    private val streams = ConcurrentHashMap.newKeySet<Stream>()
    private val rng = SecureRandom()
    @Volatile private var preferredIp = ""
    private val busy = AtomicInteger()
    /** Called with true when the first transfer starts and false when the last one ends (to hold a wake lock). */
    @Volatile var onBusy: ((Boolean) -> Unit)? = null

    val isRunning: Boolean get() = http.isRunning
    val port: Int get() = http.localPort

    init {
        store.emit = { broadcast("data: $it\n\n".toByteArray()) }
        http.handler = { req, conn -> handle(req, conn) }
        Thread({
            while (true) { // keep idle event streams alive through routers and phones
                try { Thread.sleep(20_000) } catch (_: InterruptedException) { return@Thread }
                broadcast(": ping\n\n".toByteArray())
            }
        }, "ufti-ping").apply { isDaemon = true }.start()
    }

    /** Returns null when listening, otherwise an error message. */
    fun start(): String? = http.start()
    fun stop() { http.stop(); streams.toList().forEach { it.closed = true; it.conn.close() }; store.flush() }

    /** Signs the in-app web view in as "this phone". The secret is kept by the caller between launches. */
    fun isDeviceSecret(secret: String?) = auth.lookup(secret)?.kind == "device"
    fun createLocalSession(): String = auth.create("device", "This phone").first

    // ---- live updates ----
    private fun broadcast(data: ByteArray) {
        for (s in streams) if (s.queue.size > 2000) { s.closed = true; s.conn.close() } else s.queue.offer(data)
    }
    private fun closeStreams(sid: String) {
        for (s in streams.toList()) if (s.sid == sid) { s.closed = true; s.queue.offer(ByteArray(0)); s.conn.close() }
    }

    // ---- helpers ----
    private fun lanIPs(): List<String> {
        val ips = addresses().map { it.ip }.sortedBy { if (it.startsWith("192.168.")) 0 else 1 }
        return if (preferredIp.isNotEmpty() && preferredIp in ips) listOf(preferredIp) + ips.filter { it != preferredIp } else ips
    }
    private fun pairUrl(ip: String) = "http://$ip:${port}/?p=${auth.currentPairing().first}"

    private fun cleanName(raw: String): String {
        val base = raw.substringAfterLast('/').substringAfterLast('\\')
        val s = base.map { if (it in "<>:\"/\\|?*" || it.isISOControl()) '_' else it }.joinToString("").take(200)
        return if (s.isEmpty() || s == "." || s == "..") "file" else s
    }
    private fun hexId() = ByteArray(4).also { rng.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private fun isHexId(s: String) = s.length == 8 && s.all { it in '0'..'9' || it in 'a'..'f' }
    private fun hostIsLocal(h: String?): Boolean {
        val host = (h ?: return false).lowercase().let { if (it.startsWith("[")) it.substringBefore("]") + "]" else it.substringBefore(':') }
        return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
    }
    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    private val mime = mapOf("html" to "text/html; charset=utf-8", "js" to "text/javascript", "css" to "text/css",
        "json" to "application/json", "webmanifest" to "application/manifest+json", "svg" to "image/svg+xml", "png" to "image/png")

    private fun page(c: HttpConnection, status: Int, title: String, body: String) {
        val css = "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F2F5FB;color:#10213F;font:16px/1.4 system-ui,sans-serif}" +
            "@media(prefers-color-scheme:dark){body{background:#071226;color:#EAF0FF}.c{background:#0F2145!important;border-color:#1F3568!important}}" +
            ".c{max-width:340px;margin:16px;padding:22px;border:1px solid #DCE3F0;border-radius:16px;background:#fff;border-top:4px solid #F58220}" +
            "h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#5A6B88}"
        c.text(status, "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>UFTI</title><style>$css</style><div class=\"c\"><h1>${esc(title)}</h1>$body</div>",
            "text/html; charset=utf-8")
    }

    private val hotspotNote = "An app can't start the Android hotspot. Turn on the Wi-Fi hotspot in Settings, then use the Phone hotspot tab."

    // ---- routing ----
    private fun handle(req: HttpRequest, c: HttpConnection) {
        val loop = req.isLoopback
        val ip = req.remoteIp
        val p = req.path

        // Requests from the phone itself must be addressed to localhost (guards against DNS rebinding).
        if (loop && !hostIsLocal(req.header("host"))) return c.text(421, "Misdirected request")

        // Pairing: the one-time code in the QR link becomes a session cookie, then the address is cleaned.
        val code = req.query["p"]
        if (req.method == "GET" && p == "/" && code != null) {
            val wait = auth.blockedFor(ip)
            if (wait > 0) return c.text(429, "Too many attempts. Try again in $wait seconds.", extra = mapOf("Retry-After" to wait.toString()))
            val r = if (auth.peek(code)) auth.consume(code, req.header("user-agent") ?: "") else null
            if (r == null) {
                auth.fail(ip)
                return page(c, 403, "Pairing link expired", "<p>This link was already used or has expired. Scan the QR code in the UFTI app on the Android phone again.</p>")
            }
            return c.respond(303, mapOf("Set-Cookie" to auth.cookieHeader(r.first), "Location" to "/"))
        }

        // The page and its icons are public; everything useful sits behind the API.
        if (req.method == "GET" && !p.startsWith("/api/")) return serveStatic(p, c)

        // API: needs a paired device (cookie) or a share key.
        val wait = auth.blockedFor(ip)
        if (wait > 0) return c.text(429, "Too many attempts. Try again in $wait seconds.", extra = mapOf("Retry-After" to wait.toString()))
        val a = auth.authenticate(req.cookie(Auth.COOKIE), req.header("x-token") ?: req.query["t"])
        val session = a.session
        if (session == null) {
            if (a.presented) auth.fail(ip) // only wrong credentials count as a failed attempt
            return c.json(401, JSONObject().put("error", "not paired"))
        }
        val viaKey = a.via == "key"
        if (viaKey && !(req.method == "POST" && (p == "/api/upload" || p == "/api/text"))) {
            return c.json(403, JSONObject().put("error", "share keys can only send files and text"))
        }
        if (!viaKey && req.method != "GET" && req.method != "HEAD") { // CSRF: changes must come from our own page
            val origin = req.header("origin")
            val bad = origin != null && runCatching {
                val u = URI(origin); (if (u.port >= 0) "${u.host}:${u.port}" else u.host) != req.header("host")
            }.getOrDefault(true)
            if (bad || req.header("sec-fetch-site") == "cross-site") return c.json(403, JSONObject().put("error", "cross-site request refused"))
        }
        val sid = session.h
        val pcOnly = loop && !viaKey

        // Live updates (Server-Sent Events). The connection stays open until the page goes away.
        if (req.method == "GET" && p == "/api/events") {
            c.keepAlive = false
            if (!c.sendHead(200, mapOf("Content-Type" to "text/event-stream", "Cache-Control" to "no-cache, no-transform",
                    "X-Accel-Buffering" to "no"), null)) return
            if (!c.write("retry: 2000\n\n".toByteArray())) return
            val s = Stream(c, sid)
            streams.add(s)
            // The connection is only read to notice the peer leaving; events are written from here.
            Thread({ c.waitForClose(); s.closed = true; s.queue.offer(ByteArray(0)) }, "ufti-sse-watch").apply { isDaemon = true }.start()
            try {
                while (!s.closed) {
                    val d = s.queue.poll(25, TimeUnit.SECONDS) ?: continue
                    if (d.isEmpty()) continue
                    if (!c.write(d)) break
                }
            } finally { streams.remove(s); c.close() }
            return
        }

        // In-app window only: connection, hotspot, firewall, pairing, paired devices and share keys.
        if (p in setOf("/api/network", "/api/network/select", "/api/hotspot", "/api/firewall", "/api/pairing", "/api/devices", "/api/keys")
            || p.startsWith("/api/devices/") || p.startsWith("/api/copy/")) {
            if (!pcOnly) return c.json(403, JSONObject().put("error", "only available in the UFTI app on the Android phone"))
            return handleLocal(req, c, sid)
        }

        if (req.method == "GET" && p == "/api/info") {
            val info = JSONObject().put("items", JSONArray().also { arr -> store.all().forEach { arr.put(it.toJson()) } })
                .put("host", hostName).put("me", JSONObject().put("id", sid.take(12)).put("name", session.name))
            return c.json(200, info)
        }

        if (req.method == "GET" && p == "/api/qr") {
            val svg = Net.qrSvg(req.query["u"] ?: "") ?: return c.text(500, "qr failed")
            return c.respond(200, mapOf("Content-Type" to "image/svg+xml"), svg.toByteArray())
        }

        if (req.method == "POST" && p == "/api/upload") return handleUpload(req, c)

        if (req.method == "POST" && p == "/api/text") {
            val body = c.readBody(1_000_000) ?: return
            var text = String(body, Charsets.UTF_8)
            var from = req.header("x-device") ?: req.query["device"]
            var fromId = req.header("x-client") ?: req.query["client"] ?: ""
            runCatching {
                val j = JSONObject(text)
                if (j.has("text")) {
                    text = j.getString("text")
                    j.optString("from").takeIf { it.isNotEmpty() }?.let { from = it }
                    j.optString("fromId").takeIf { it.isNotEmpty() }?.let { fromId = it }
                }
            }
            if (text.isBlank()) return c.json(400, JSONObject().put("error", "empty"))
            val item = Item(hexId(), "text", null, null, text.take(100_000), from ?: "device", fromId, System.currentTimeMillis())
            store.add(item)
            return c.json(200, item.toJson())
        }

        if (req.method == "GET" && p.startsWith("/api/file/")) {
            val id = p.removePrefix("/api/file/")
            val item = if (isHexId(id)) store.find(id) else null
            if (item == null || item.kind != "file") return c.text(404, "")
            val enc = URLEncoder.encode(item.name ?: "file", "UTF-8").replace("+", "%20")
            beginBusy()
            try {
                c.respondFile(store.fileOf(item), mapOf("Content-Type" to "application/octet-stream",
                    "Content-Disposition" to "attachment; filename*=UTF-8''$enc"))
            } finally { endBusy() }
            return
        }

        if (req.method == "DELETE" && p.startsWith("/api/item/")) {
            val id = p.removePrefix("/api/item/")
            return if (store.remove(id, true)) c.json(200, JSONObject().put("ok", true))
            else c.json(404, JSONObject().put("error", "gone"))
        }

        // Clear history entries. Body: { ids: [...], deleteFiles: bool }. Omit ids to clear everything.
        if (req.method == "POST" && p == "/api/clear") {
            val opts = runCatching { JSONObject(String(c.readBody(1_000_000) ?: ByteArray(0))) }.getOrDefault(JSONObject())
            val ids = if (opts.has("ids")) opts.getJSONArray("ids").let { arr -> (0 until arr.length()).map { arr.getString(it) } }
            else store.all().map { it.id }
            val del = opts.optBoolean("deleteFiles", false)
            var removed = 0
            for (id in ids) if (store.remove(id, del)) removed++
            return c.json(200, JSONObject().put("removed", removed))
        }

        c.json(404, JSONObject().put("error", "unknown route"))
    }

    private fun serveStatic(path: String, c: HttpConnection) {
        val rel = if (path == "/") "index.html" else path.removePrefix("/")
        if (rel.contains("..") || rel.contains('\\')) return c.text(404, "Not found")
        var data = asset("public/$rel") ?: return c.text(404, "Not found")
        // Tell the shared page it is hosted by an Android phone, so it hides the PC-only options and wording.
        if (rel == "index.html") {
            val html = String(data, Charsets.UTF_8)
            val i = html.indexOf("<head>")
            if (i >= 0) data = (html.substring(0, i + 6) + "\n<script>window.UFTI_HOST = 'android';</script>" + html.substring(i + 6)).toByteArray()
        }
        c.respond(200, mapOf("Content-Type" to (mime[rel.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream")), data)
    }

    private fun beginBusy() { if (busy.incrementAndGet() == 1) onBusy?.invoke(true) }
    private fun endBusy() { if (busy.decrementAndGet() == 0) onBusy?.invoke(false) }

    private fun handleUpload(req: HttpRequest, c: HttpConnection) {
        val device = req.header("x-device") ?: req.query["device"] ?: "device"
        val client = req.header("x-client") ?: req.query["client"] ?: ""
        if ((req.header("content-type") ?: "").lowercase().startsWith("multipart/form-data")) {
            return c.json(415, JSONObject().put("error", "multipart uploads are not supported by the Android app yet; send the raw file body"))
        }
        if (req.chunked || req.contentLength == null) return c.json(411, JSONObject().put("error", "Content-Length required"))
        var raw = req.header("x-filename") ?: req.query["name"] ?: "file"
        raw = runCatching { URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8") }.getOrDefault(raw)
        val name = cleanName(raw)
        val id = hexId()
        val dest = File(store.dir, "${id}__$name")
        beginBusy()
        try {
            val ok = try { dest.outputStream().buffered(65536).use { c.pipeBody(it) } } catch (e: IOException) {
                dest.delete(); return c.json(500, JSONObject().put("error", "write failed"))
            }
            if (!ok) { dest.delete(); return } // client went away mid-upload
        } finally { endBusy() }
        val item = Item(id, "file", name, dest.length(), null, device, client, System.currentTimeMillis())
        store.add(item)
        c.json(200, item.toJson())
    }

    /** Routes that only the app's own window may use. */
    private fun handleLocal(req: HttpRequest, c: HttpConnection, sid: String) {
        val p = req.path
        val m = req.method
        if (m == "GET" && p == "/api/network") {
            val (_, expires) = auth.currentPairing()
            val arr = JSONArray()
            addresses().forEach { arr.put(JSONObject().put("ip", it.ip).put("name", it.name).put("kind", it.kind).put("via", it.via).put("url", pairUrl(it.ip))) }
            return c.json(200, JSONObject().put("port", port).put("preferred", lanIPs().firstOrNull() ?: "").put("addresses", arr)
                .put("expires", expires).put("firewall", true))
        }
        if (m == "POST" && p == "/api/network/select") {
            val want = runCatching { JSONObject(String(c.readBody(10_000) ?: ByteArray(0))).getString("ip") }.getOrDefault("")
            if (addresses().none { it.ip == want }) return c.json(400, JSONObject().put("error", "unknown address"))
            preferredIp = want
            return c.json(200, JSONObject().put("ok", true))
        }
        if (m == "GET" && p == "/api/pairing") {
            val (pc, expires) = auth.currentPairing()
            return c.json(200, JSONObject().put("code", pc).put("expires", expires))
        }
        if (m == "GET" && p == "/api/devices") {
            val arr = JSONArray()
            auth.list().forEach {
                arr.put(JSONObject().put("id", it.id).put("kind", it.kind).put("name", it.name).put("created", it.created)
                    .put("lastSeen", it.lastSeen).put("current", it.id == sid.take(12)))
            }
            return c.json(200, JSONObject().put("devices", arr))
        }
        if (m == "DELETE" && p.startsWith("/api/devices/")) {
            val gone = auth.revoke(p.removePrefix("/api/devices/")) ?: return c.json(404, JSONObject().put("error", "not found"))
            closeStreams(gone.h)
            return c.json(200, JSONObject().put("ok", true))
        }
        if (m == "POST" && p == "/api/keys") {
            val name = runCatching { JSONObject(String(c.readBody(10_000) ?: ByteArray(0))).optString("name") }.getOrDefault("")
            val (secret, s) = auth.create("key", name.ifEmpty { "Share key" })
            return c.json(200, JSONObject().put("key", secret).put("id", s.id).put("name", s.name))
        }
        if (p == "/api/hotspot") {
            return if (m == "GET") c.json(200, JSONObject().put("supported", false).put("state", "Off").put("error", hotspotNote))
            else c.json(200, JSONObject().put("ok", false).put("error", hotspotNote))
        }
        if (m == "POST" && p == "/api/firewall") return c.json(200, JSONObject().put("ok", true))
        // Copy a received file to the phone's clipboard: images as an image, anything else as a file.
        if (m == "POST" && p.startsWith("/api/copy/")) {
            val id = p.removePrefix("/api/copy/")
            val item = if (isHexId(id)) store.find(id) else null
            if (item == null || item.kind != "file") return c.json(404, JSONObject().put("error", "gone"))
            val h = copyHandler ?: return c.json(501, JSONObject().put("error", "copy is not available here"))
            val kind = runCatching { h(store.fileOf(item)) }.getOrNull()
                ?: return c.json(500, JSONObject().put("error", "could not copy this file"))
            return c.json(200, JSONObject().put("ok", true).put("as", kind))
        }
        c.json(404, JSONObject().put("error", "unknown route"))
    }
}
