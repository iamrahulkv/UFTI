package com.ufti.android

import android.app.Application
import android.content.Context
import com.ufti.android.server.UFTIServer
import java.io.File

/**
 * Owns the server for the whole process, so it keeps running when the screen is closed (the foreground service keeps the
 * process alive). The phone is a host (shows its own QR code) and can also be a client (scans another UFTI's code, see
 * [Connection]).
 */
class UFTIApp : Application() {
    lateinit var server: UFTIServer
        private set
    val connection by lazy { Connection(getSharedPreferences("ufti", Context.MODE_PRIVATE)) }

    override fun onCreate() {
        super.onCreate()
        server = UFTIServer(
            port = PORT,
            dataDir = File(filesDir, "ufti"),
            receivedDir = File(filesDir, "received"),
            hostName = android.os.Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android",
            asset = { path -> runCatching { assets.open(path).use { it.readBytes() } }.getOrNull() },
        )
        server.copyHandler = { file -> Files.copyToClipboard(this, file) }
    }

    companion object { const val PORT = 8787 }
}

/** Which device the page belongs to: this phone, or another UFTI we scanned. */
class Connection(private val prefs: android.content.SharedPreferences) {
    var remote: RemoteLink? = null          // set while connected to another device
    var pageUrl: String? = null             // what the page loads first: the pairing link, then just the base
    var lastRemote: String? = prefs.getString("lastRemote", null)

    val isClient get() = remote != null
    fun startUrl() = pageUrl ?: "http://localhost:${UFTIApp.PORT}/"

    fun connect(link: RemoteLink) {
        remote = link; pageUrl = link.start; lastRemote = link.base
        prefs.edit().putString("lastRemote", link.base).apply()
    }

    /** Opens the last device again. Its login cookie is still stored, so no new scan is needed (if it was removed there, scan again). */
    fun reconnect(): Boolean {
        val b = lastRemote ?: return false
        val link = RemoteLink.parse("${b}?p=x") ?: return false
        remote = link; pageUrl = link.base
        return true
    }

    fun disconnect() { remote = null; pageUrl = null }

    /** The pairing code is used up after the first load; a rebuilt page must open the plain address. */
    fun pairingConsumed() { pageUrl = remote?.base }

    /** The secret that signs the in-app web view in as "this phone", kept between launches. */
    fun localSecret(server: UFTIServer): String {
        val cur = prefs.getString("localSecret", null)
        if (cur != null && server.isDeviceSecret(cur)) return cur
        return server.createLocalSession().also { prefs.edit().putString("localSecret", it).apply() }
    }
}
