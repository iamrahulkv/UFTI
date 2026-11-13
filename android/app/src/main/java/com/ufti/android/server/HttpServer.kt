package com.ufti.android.server

import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors

class HttpRequest(
    val method: String,
    val path: String,                 // decoded
    val query: Map<String, String>,
    val headers: Map<String, String>, // lower-case names
    val remoteIp: String,
    val contentLength: Long?,
    val chunked: Boolean,
) {
    val isLoopback: Boolean get() = remoteIp.startsWith("127.") || remoteIp == "::1" || remoteIp == "0:0:0:0:0:0:0:1" || remoteIp.startsWith("::ffff:127.")
    fun header(name: String): String? = headers[name.lowercase()]
    fun cookie(name: String): String? {
        for (part in (headers["cookie"] ?: "").split(';')) {
            val i = part.indexOf('=')
            if (i > 0 && part.substring(0, i).trim() == name) return part.substring(i + 1).trim()
        }
        return null
    }
}

/** One client connection. Blocking I/O, served on its own thread; keep-alive is supported. */
class HttpConnection(val socket: Socket) {
    private val input = BufferedInputStream(socket.getInputStream(), 65536)
    private val output: OutputStream = socket.getOutputStream()
    var keepAlive = true
    var bodyLeft = 0L
    private var expectContinue = false

    companion object {
        val common = mapOf(
            "Referrer-Policy" to "no-referrer",
            "X-Content-Type-Options" to "nosniff",
            "X-Frame-Options" to "DENY",
            "Cache-Control" to "no-store",
            "Content-Security-Policy" to "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
        )
        fun reason(s: Int) = when (s) {
            100 -> "Continue"; 200 -> "OK"; 303 -> "See Other"; 400 -> "Bad Request"; 401 -> "Unauthorized"
            403 -> "Forbidden"; 404 -> "Not Found"; 411 -> "Length Required"; 415 -> "Unsupported Media Type"
            421 -> "Misdirected Request"; 429 -> "Too Many Requests"; 500 -> "Internal Server Error"; else -> "OK"
        }
    }

    // ---- request ----
    fun readHead(): HttpRequest? {
        val buf = java.io.ByteArrayOutputStream()
        var tail = 0
        while (true) {
            val b = try { input.read() } catch (e: IOException) { return null }
            if (b < 0) return null
            buf.write(b)
            tail = ((tail shl 8) or b) // last four bytes
            if (tail == 0x0D0A0D0A) break
            if (buf.size() > 65536) return null
        }
        val req = parse(buf.toString("UTF-8")) ?: return null
        bodyLeft = req.contentLength ?: 0L
        expectContinue = (req.header("expect") ?: "").lowercase().contains("100-continue")
        return req
    }

    private fun dec(s: String) = try { URLDecoder.decode(s, "UTF-8") } catch (e: Exception) { s }

    private fun parse(head: String): HttpRequest? {
        val lines = head.split("\r\n")
        val first = lines[0].split(' ')
        if (first.size < 2) return null
        val headers = HashMap<String, String>()
        for (l in lines.drop(1)) {
            val i = l.indexOf(':'); if (i <= 0) continue
            headers[l.substring(0, i).lowercase()] = l.substring(i + 1).trim()
        }
        val target = first[1]
        val q = target.indexOf('?')
        val rawPath = if (q >= 0) target.substring(0, q) else target
        val query = LinkedHashMap<String, String>()
        if (q >= 0) for (kv in target.substring(q + 1).split('&')) {
            if (kv.isEmpty()) continue
            val e = kv.indexOf('=')
            val k = dec(if (e >= 0) kv.substring(0, e) else kv)
            if (!query.containsKey(k)) query[k] = if (e >= 0) dec(kv.substring(e + 1)) else ""
        }
        var ip = socket.inetAddress?.hostAddress ?: ""
        val pct = ip.indexOf('%'); if (pct >= 0) ip = ip.substring(0, pct)
        return HttpRequest(first[0].uppercase(), dec(rawPath.replace("+", "%2B")).ifEmpty { "/" }, query, headers, ip,
            headers["content-length"]?.toLongOrNull(), (headers["transfer-encoding"] ?: "").lowercase().contains("chunked"))
    }

    private fun sendContinueIfNeeded() {
        if (expectContinue && bodyLeft > 0) {
            expectContinue = false
            output.write("HTTP/1.1 100 Continue\r\n\r\n".toByteArray()); output.flush()
        }
    }

    /** Reads up to `max` bytes of the body. Anything beyond stays unread and the connection is closed afterwards. */
    fun readBody(max: Int): ByteArray? {
        return try {
            sendContinueIfNeeded()
            val want = minOf(bodyLeft, max.toLong()).toInt()
            val out = ByteArray(want)
            var got = 0
            while (got < want) {
                val n = input.read(out, got, want - got)
                if (n < 0) return null
                got += n
            }
            bodyLeft -= want
            out
        } catch (e: IOException) { null }
    }

    /** Streams the whole body into `os`. Returns false if the connection dropped or the write failed. */
    fun pipeBody(os: OutputStream): Boolean {
        return try {
            sendContinueIfNeeded()
            val buf = ByteArray(65536)
            while (bodyLeft > 0) {
                val n = input.read(buf, 0, minOf(buf.size.toLong(), bodyLeft).toInt())
                if (n < 0) return false
                os.write(buf, 0, n)
                bodyLeft -= n
            }
            true
        } catch (e: IOException) { false }
    }

    /** Blocks until the peer closes the connection (used by long-lived event streams). */
    fun waitForClose() {
        try { socket.soTimeout = 0; while (input.read() >= 0) { /* ignore */ } } catch (e: IOException) { /* gone */ }
    }

    // ---- response ----
    @Synchronized
    fun write(data: ByteArray): Boolean = try { output.write(data); output.flush(); true } catch (e: IOException) { false }

    fun sendHead(status: Int, headers: Map<String, String> = emptyMap(), length: Long?): Boolean {
        val h = LinkedHashMap(common)
        h.putAll(headers)
        if (length != null) h["Content-Length"] = length.toString() else keepAlive = false
        h["Connection"] = if (keepAlive) "keep-alive" else "close"
        val sb = StringBuilder("HTTP/1.1 $status ${reason(status)}\r\n")
        h.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
        sb.append("\r\n")
        return write(sb.toString().toByteArray())
    }

    fun respond(status: Int, headers: Map<String, String> = emptyMap(), body: ByteArray = ByteArray(0)) {
        if (!sendHead(status, headers, body.size.toLong())) return
        if (body.isNotEmpty()) write(body)
    }
    fun text(status: Int, s: String, type: String = "text/plain; charset=utf-8", extra: Map<String, String> = emptyMap()) =
        respond(status, extra + ("Content-Type" to type), s.toByteArray())
    fun json(status: Int, o: Any) = respond(status, mapOf("Content-Type" to "application/json"), o.toString().toByteArray())

    /** Sends a file in chunks, so a big file never sits in memory. */
    fun respondFile(file: File, headers: Map<String, String>) {
        val fis = try { file.inputStream() } catch (e: IOException) { return text(404, "Not found") }
        fis.use {
            if (!sendHead(200, headers, file.length())) return
            val buf = ByteArray(65536)
            try {
                while (true) {
                    val n = it.read(buf); if (n < 0) break
                    output.write(buf, 0, n)
                }
                output.flush()
            } catch (e: IOException) { close() }
        }
    }

    fun close() { try { socket.close() } catch (_: IOException) {} }
}

/** A small HTTP/1.1 server: request heads, Content-Length bodies streamed to disk, streamed file responses and event streams. */
class HttpServer(private val port: Int) {
    var handler: ((HttpRequest, HttpConnection) -> Unit)? = null
    @Volatile var isRunning = false; private set
    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "ufti-http").apply { isDaemon = true } }

    /** Returns null when listening, otherwise a message saying why not. */
    @Synchronized fun start(): String? {
        stop()
        return try {
            val s = ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(port)) }
            server = s; isRunning = true
            Thread({ acceptLoop(s) }, "ufti-accept").apply { isDaemon = true }.start()
            null
        } catch (e: IOException) { "Could not open port $port (${e.message})." }
    }

    @Synchronized fun stop() { isRunning = false; try { server?.close() } catch (_: IOException) {}; server = null }

    val localPort: Int get() = server?.localPort ?: port

    private fun acceptLoop(s: ServerSocket) {
        while (!s.isClosed) {
            val sock = try { s.accept() } catch (e: IOException) { break }
            pool.execute { serve(sock) }
        }
        if (server === s) isRunning = false
    }

    private fun serve(sock: Socket) {
        val conn = HttpConnection(sock)
        try {
            sock.tcpNoDelay = true
            while (true) {
                sock.soTimeout = 120_000
                val req = conn.readHead() ?: break
                conn.keepAlive = (req.header("connection") ?: "").lowercase() != "close"
                try { handler?.invoke(req, conn) } catch (e: Exception) {
                    if (!sock.isClosed) conn.json(500, org.json.JSONObject().put("error", "server error"))
                    break
                }
                if (!conn.keepAlive || conn.bodyLeft > 0) break
            }
        } catch (_: Exception) {
        } finally { conn.close() }
    }
}
