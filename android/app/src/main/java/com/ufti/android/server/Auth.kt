package com.ufti.android.server

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** Port of auth.js: one-time pairing codes, per-device sessions, share keys, rate limiting. Only SHA-256 hashes hit the disk. */
class Auth(dataDir: File) {
    data class Session(val h: String, val kind: String, val name: String, val created: Long, var lastSeen: Long) {
        val id: String get() = h.take(12)
    }
    data class Result(val session: Session?, val via: String, val presented: Boolean)
    private class Pairing(val code: String, val expires: Long, var used: Boolean = false)
    private class Fail(var start: Long, var count: Int, var blockedUntil: Long)

    companion object {
        const val COOKIE = "ufti_session"
        private const val PAIR_TTL = 5 * 60_000L
        private const val PAIR_REFRESH = 60_000L
        private const val LIMIT_WINDOW = 60_000L
        private const val LIMIT_MAX = 20
        private const val LIMIT_BLOCK = 60_000L
        private val rng = SecureRandom()

        fun sha(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }

        fun secret(prefix: String = ""): String {
            val b = ByteArray(16); rng.nextBytes(b) // 128 bits
            return prefix + Base64.getUrlEncoder().withoutPadding().encodeToString(b)
        }

        fun deviceName(ua: String): String {
            val os = when {
                ua.contains("iPhone") -> "iPhone"; ua.contains("iPad") -> "iPad"; ua.contains("Android") -> "Android"
                ua.contains("Windows") -> "Windows PC"; ua.contains("Mac") -> "Mac"; ua.contains("Linux") -> "Linux"
                else -> "Device"
            }
            val browser = when {
                ua.contains("UFTIAndroid") -> "UFTI app"
                ua.contains("Edg/") -> "Edge"; ua.contains("OPR/") -> "Opera"; ua.contains("SamsungBrowser") -> "Samsung Internet"
                ua.contains("Firefox") || ua.contains("FxiOS") -> "Firefox"
                ua.contains("CriOS") || ua.contains("Chrome") -> "Chrome"
                ua.contains("Safari") -> "Safari"
                else -> ""
            }
            return if (browser.isEmpty()) os else "$os · $browser"
        }
    }

    private val file = File(dataDir, "sessions.json")
    private val sessions = HashMap<String, Session>()
    private var pairing: Pairing? = null
    private val fails = HashMap<String, Fail>()
    private fun now() = System.currentTimeMillis()

    init {
        dataDir.mkdirs()
        runCatching {
            val arr = JSONArray(file.readText())
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                sessions[o.getString("h")] = Session(o.getString("h"), o.getString("kind"), o.getString("name"),
                    o.getLong("created"), o.getLong("lastSeen"))
            }
        }
    }

    private fun save() { // caller holds the lock
        val arr = JSONArray()
        sessions.values.forEach {
            arr.put(JSONObject().put("h", it.h).put("kind", it.kind).put("name", it.name).put("created", it.created).put("lastSeen", it.lastSeen))
        }
        runCatching {
            val tmp = File(file.parentFile, "sessions.json.tmp")
            tmp.writeText(arr.toString())
            if (!tmp.renameTo(file)) { file.writeText(arr.toString()); tmp.delete() }
        }
    }

    private fun same(a: String, b: String) = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

    @Synchronized fun create(kind: String, name: String): Pair<String, Session> {
        val value = secret(if (kind == "key") "uk_" else "")
        val s = Session(sha(value), kind, name.ifEmpty { "Device" }.take(60), now(), now())
        sessions[s.h] = s; save()
        return value to s
    }

    @Synchronized fun lookup(value: String?): Session? {
        if (value.isNullOrEmpty()) return null
        val s = sessions[sha(value)] ?: return null
        if (now() - s.lastSeen > 60_000) { s.lastSeen = now(); save() } // touch at most once a minute
        return s
    }

    @Synchronized fun list(): List<Session> = sessions.values.sortedByDescending { it.lastSeen }

    @Synchronized fun revoke(id: String): Session? {
        val s = sessions.values.firstOrNull { it.id == id } ?: return null
        sessions.remove(s.h); save()
        return s
    }

    /** Cookie (browsers) or share key (tools). `presented` says whether credentials were sent at all. */
    fun authenticate(cookie: String?, key: String?): Result {
        val k = key ?: ""
        if (cookie.isNullOrEmpty() && k.isEmpty()) return Result(null, "", false)
        lookup(cookie)?.takeIf { it.kind == "device" }?.let { return Result(it, "cookie", true) }
        lookup(k)?.takeIf { it.kind == "key" }?.let { return Result(it, "key", true) }
        return Result(null, "", true)
    }

    @Synchronized fun currentPairing(): Pair<String, Long> {
        val p = pairing
        val cur = if (p == null || p.used || p.expires - now() < PAIR_REFRESH) Pairing(secret(), now() + PAIR_TTL).also { pairing = it } else p
        return cur.code to cur.expires
    }

    /** Is this code still usable? Does not use it up. */
    @Synchronized fun peek(code: String): Boolean {
        val p = pairing ?: return false
        return same(p.code, code) && !p.used && p.expires > now()
    }

    /** Uses the code up and creates the device session. */
    fun consume(code: String, userAgent: String): Pair<String, Session>? {
        synchronized(this) {
            val p = pairing
            if (p == null || !same(p.code, code) || p.used || p.expires <= now()) return null
            p.used = true
        }
        return create("device", deviceName(userAgent))
    }

    @Synchronized fun blockedFor(ip: String): Int {
        val f = fails[ip] ?: return 0
        if (f.blockedUntil <= now()) return 0
        return ((f.blockedUntil - now() + 999) / 1000).toInt()
    }

    @Synchronized fun fail(ip: String) {
        val f = fails.getOrPut(ip) { Fail(now(), 0, 0) }
        if (now() - f.start > LIMIT_WINDOW) { f.start = now(); f.count = 0 }
        f.count++
        if (f.count > LIMIT_MAX) f.blockedUntil = now() + LIMIT_BLOCK
        if (fails.size > 1000) fails.entries.removeAll { now() - it.value.start > LIMIT_WINDOW && it.value.blockedUntil < now() }
    }

    fun cookieHeader(value: String) = "$COOKIE=$value; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 24 * 60 * 60}"
}
