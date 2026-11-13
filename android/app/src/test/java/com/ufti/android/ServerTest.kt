package com.ufti.android

import com.ufti.android.server.Auth
import com.ufti.android.server.NetAddr
import com.ufti.android.server.UFTIServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.Socket
import java.net.URL
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/** End-to-end tests of the Android server on the plain JVM: same routes and behaviour as server.js. */
class ServerTest {
    private lateinit var tmp: File
    private lateinit var server: UFTIServer
    private val base get() = "http://127.0.0.1:${server.port}"
    private val ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"

    class Res(val status: Int, val headers: Map<String, List<String>>, val body: ByteArray) {
        val text get() = String(body)
        val json get() = JSONObject(text)
        fun header(n: String) = headers.entries.firstOrNull { it.key.equals(n, true) }?.value?.firstOrNull()
    }

    @Before fun setUp() {
        tmp = Files.createTempDirectory("ufti-android").toFile()
        server = UFTIServer(0, File(tmp, "data"), File(tmp, "received"), "Test phone",
            asset = { p -> if (p == "public/index.html") "<!doctype html><html><head><title>x</title></head><body>hi</body></html>".toByteArray() else null },
            addresses = { listOf(NetAddr("192.168.1.20", "wlan0", "network", "Wi-Fi / network")) })
        assertNull(server.start())
    }
    @After fun tearDown() { server.stop(); tmp.deleteRecursively() }

    private fun call(method: String, path: String, cookie: String? = null, body: ByteArray? = null,
                     headers: Map<String, String> = emptyMap()): Res {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false
        c.requestMethod = method
        c.setRequestProperty("User-Agent", ua)
        if (cookie != null) c.setRequestProperty("Cookie", cookie)
        headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
        if (body != null) { c.doOutput = true; c.setFixedLengthStreamingMode(body.size); c.outputStream.use { it.write(body) } }
        val st = c.responseCode
        val bytes = (if (st >= 400) c.errorStream else c.inputStream)?.use { it.readBytes() } ?: ByteArray(0)
        return Res(st, c.headerFields.filterKeys { it != null }, bytes)
    }

    private fun pair(): String {
        val r = call("GET", "/?p=" + server.auth.currentPairing().first)
        assertEquals(303, r.status)
        return r.header("Set-Cookie")!!.substringBefore(';')
    }

    @Test fun pairingIsOneTimeAndSetsASafeCookie() {
        val code = server.auth.currentPairing().first
        val r = call("GET", "/?p=$code")
        assertEquals(303, r.status); assertEquals("/", r.header("Location"))
        val sc = r.header("Set-Cookie")!!
        assertTrue(sc.contains("HttpOnly") && sc.contains("SameSite=Strict"))
        assertEquals("the code works once", 403, call("GET", "/?p=$code").status)
        assertEquals(401, call("GET", "/api/info").status)
        assertEquals(401, call("GET", "/api/info?t=madeup").status)
    }

    @Test fun pageIsPublicAndTagged() {
        val r = call("GET", "/")
        assertEquals(200, r.status)
        assertTrue(r.text.contains("window.UFTI_HOST = 'android'"))
        assertEquals("no-referrer", r.header("Referrer-Policy"))
        assertTrue(r.header("Content-Security-Policy")!!.contains("default-src 'self'"))
        assertEquals(404, call("GET", "/nope.txt").status)
        assertEquals(404, call("GET", "/../secret").status)
    }

    @Test fun dnsRebindingGuard() {
        Socket("127.0.0.1", server.port).use { s ->
            s.getOutputStream().write("GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n".toByteArray())
            val line = BufferedReader(InputStreamReader(s.getInputStream())).readLine()
            assertTrue(line, line.contains("421"))
        }
    }

    @Test fun textUploadDownloadDeleteClear() {
        val c = pair()
        val info = call("GET", "/api/info", c).json
        assertEquals("Test phone", info.getString("host"))
        assertEquals(0, info.getJSONArray("items").length())

        val t = call("POST", "/api/text", c, """{"text":"hello","from":"Android","fromId":"abc"}""".toByteArray(),
            mapOf("Content-Type" to "application/json")).json
        assertEquals("text", t.getString("kind")); assertEquals("hello", t.getString("text")); assertEquals("abc", t.getString("fromId"))
        assertEquals(400, call("POST", "/api/text", c, "   ".toByteArray()).status)

        val data = ByteArray(300_000) { (it * 7).toByte() }
        val up = call("POST", "/api/upload", c, data, mapOf("x-filename" to "caf%C3%A9 %3Cphoto%3E.bin", "x-device" to "Windows PC", "x-client" to "cl1")).json
        val id = up.getString("id")
        assertEquals(8, id.length); assertEquals(300_000L, up.getLong("size")); assertEquals("café _photo_.bin", up.getString("name"))
        val dl = call("GET", "/api/file/$id", c)
        assertEquals(200, dl.status); assertTrue(data.contentEquals(dl.body))
        assertTrue(dl.header("Content-Disposition")!!.contains("filename*=UTF-8''caf%C3%A9%20"))
        assertEquals(404, call("GET", "/api/file/zzzzzzzz", c).status)
        assertEquals(2, call("GET", "/api/info", c).json.getJSONArray("items").length())

        assertEquals(200, call("DELETE", "/api/item/${t.getString("id")}", c).status)
        assertEquals(404, call("DELETE", "/api/item/${t.getString("id")}", c).status)
        val cleared = call("POST", "/api/clear", c, """{"ids":["$id"],"deleteFiles":true}""".toByteArray()).json
        assertEquals(1, cleared.getInt("removed"))
        assertEquals(0, call("GET", "/api/info", c).json.getJSONArray("items").length())
    }

    @Test fun shareKeysOnlySendFilesAndText() {
        val c = pair()
        val k = call("POST", "/api/keys", c, """{"name":"Phone shortcut"}""".toByteArray()).json.getString("key")
        assertTrue(k.startsWith("uk_"))
        assertEquals(200, call("POST", "/api/upload?t=$k&name=a.txt", null, "abc".toByteArray()).status)
        assertEquals(200, call("POST", "/api/text", null, "from a key".toByteArray(), mapOf("x-token" to k)).status)
        assertEquals(403, call("GET", "/api/info?t=$k").status)
        assertEquals(415, call("POST", "/api/upload?t=$k", null, "x".toByteArray(), mapOf("Content-Type" to "multipart/form-data; boundary=x")).status)
        val id = call("GET", "/api/devices", c).json.getJSONArray("devices").let { d -> (0 until d.length()).map { d.getJSONObject(it) }.first { it.getString("kind") == "key" }.getString("id") }
        assertEquals(200, call("DELETE", "/api/devices/$id", c).status)
        assertEquals(401, call("POST", "/api/text?t=$k", null, "x".toByteArray()).status)
    }

    @Test fun crossSiteWritesAreRefused() {
        val c = pair()
        // HttpURLConnection silently drops the Origin header, so these go over a raw socket.
        fun status(extra: String): Int = Socket("127.0.0.1", server.port).use { s ->
            s.getOutputStream().write(("POST /api/text HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nCookie: $c\r\n$extra" +
                "Content-Length: 2\r\nConnection: close\r\n\r\nhi").toByteArray())
            BufferedReader(InputStreamReader(s.getInputStream())).readLine().split(' ')[1].toInt()
        }
        assertEquals(403, status("Origin: http://evil.example\r\n"))
        assertEquals(403, status("Sec-Fetch-Site: cross-site\r\n"))
        assertEquals(200, status("Origin: http://127.0.0.1:${server.port}\r\n"))
    }

    @Test fun networkAndQr() {
        val c = pair()
        val n = call("GET", "/api/network", c).json
        assertEquals("192.168.1.20", n.getString("preferred"))
        val url = n.getJSONArray("addresses").getJSONObject(0).getString("url")
        assertTrue(url, Regex("^http://192\\.168\\.1\\.20:${server.port}/\\?p=[A-Za-z0-9_-]{22}$").matches(url))
        assertNotNull(RemoteLink.parse(url.replace(":${server.port}", ":8787")))
        val qr = call("GET", "/api/qr?u=" + java.net.URLEncoder.encode(url, "UTF-8"), c)
        assertEquals("image/svg+xml", qr.header("Content-Type")); assertTrue(qr.text.startsWith("<svg"))
        assertEquals(200, call("GET", "/api/hotspot", c).status)
    }

    @Test fun liveEventsArriveOverSse() {
        val c = pair()
        val s = Socket("127.0.0.1", server.port)
        s.soTimeout = 5000
        s.getOutputStream().write("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nCookie: $c\r\n\r\n".toByteArray())
        val r = BufferedReader(InputStreamReader(s.getInputStream()))
        assertTrue(r.readLine().contains("200"))
        while (r.readLine().isNotEmpty()) { /* headers */ }
        assertEquals("retry: 2000", r.readLine())
        call("POST", "/api/text", c, "ping".toByteArray())
        var line: String?
        do { line = r.readLine() } while (line != null && !line.startsWith("data:"))
        assertTrue(line, line!!.contains("\"type\":\"add\"") && line.contains("ping"))
        s.close()
    }

    @Test fun repeatedWrongCredentialsAreRateLimited() {
        repeat(21) { call("GET", "/api/info?t=bad$it") }
        assertEquals(429, call("GET", "/api/info?t=again").status)
    }

    @Test fun historySurvivesARestart() {
        val c = pair()
        call("POST", "/api/upload?name=keep.txt", c, "data".toByteArray())
        server.stop()
        val again = UFTIServer(0, File(tmp, "data"), File(tmp, "received"), "Test phone", asset = { null })
        assertEquals(listOf("keep.txt"), again.store.all().map { it.name })
        assertTrue(again.isDeviceSecret(c.substringAfter('=')))
    }

    @Test fun remoteLinksMatchTheIphoneRules() {
        assertNotNull(RemoteLink.parse("http://192.168.1.20:8787/?p=abc"))
        assertNotNull(RemoteLink.parse("  http://10.0.0.5:8787/?p=abc_-  "))
        assertNotNull(RemoteLink.parse("http://172.20.10.1:8787?p=abc"))
        assertNotNull(RemoteLink.parse("http://mypc.local:8787/?p=abc"))
        assertNull(RemoteLink.parse("https://192.168.1.20:8787/?p=abc"))
        assertNull(RemoteLink.parse("http://example.com/?p=abc"))
        assertNull(RemoteLink.parse("http://8.8.8.8:8787/?p=abc"))
        assertNull(RemoteLink.parse("http://172.32.0.1:8787/?p=abc"))
        assertNull(RemoteLink.parse("http://192.168.1.20:8787/other?p=abc"))
        assertNull(RemoteLink.parse("http://192.168.1.20:8787/"))
        assertNull(RemoteLink.parse("WIFI:T:WPA;S:x;P:y;;"))
        assertEquals("http://192.168.1.20:8787/", RemoteLink.parse("http://192.168.1.20:8787/?p=abc")!!.base)
    }

    @Test fun deviceNames() {
        assertEquals("Android · Chrome", Auth.deviceName(ua))
        assertEquals("Android · UFTI app", Auth.deviceName("$ua UFTIAndroid/1.0"))
        assertEquals("iPhone · Safari", Auth.deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1"))
    }

    /** Drives the Android server with Node's own HTTP client (a different implementation, like the PC and iPhone are). */
    @Test fun nodeClientInterop() {
        val script = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "test/android-interop.js") }.firstOrNull { it.exists() }
        assumeTrue("test/android-interop.js not found", script != null)
        val proc = try { ProcessBuilder("node", script!!.path, base, base + "/?p=" + server.auth.currentPairing().first).redirectErrorStream(true).start() }
        catch (e: Exception) { assumeTrue("node is not installed", false); return }
        val out = proc.inputStream.bufferedReader().readText()
        assertTrue("node timed out", proc.waitFor(60, TimeUnit.SECONDS))
        assertEquals(out, 0, proc.exitValue())
    }
}
