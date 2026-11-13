package com.ufti.android.server

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Timer
import java.util.TimerTask

/** One transfer. Same JSON shape as server.js, so the shared page and the other apps read it unchanged. */
data class Item(val id: String, val kind: String, val name: String?, val size: Long?, val text: String?,
                val from: String, val fromId: String, val ts: Long) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("kind", kind).apply {
        name?.let { put("name", it) }; size?.let { put("size", it) }; text?.let { put("text", it) }
    }.put("from", from).put("fromId", fromId).put("ts", ts)

    companion object {
        fun fromJson(o: JSONObject) = Item(o.getString("id"), o.getString("kind"), o.optString("name").ifEmpty { null },
            if (o.has("size")) o.getLong("size") else null, if (o.has("text")) o.getString("text") else null,
            o.optString("from", "device"), o.optString("fromId", ""), o.optLong("ts"))
    }
}

/** Transfer history (history.json) and the received files (`<id>__<name>`). */
class Store(val dir: File, private val historyFile: File) {
    companion object { const val MAX_ITEMS = 500 }

    private val items = ArrayList<Item>()
    private var timer: Timer? = null
    /** Called with a ready-made JSON message ({"type":"add",...} or {"type":"remove",...}). */
    @Volatile var emit: ((String) -> Unit)? = null

    init { dir.mkdirs(); historyFile.parentFile?.mkdirs(); load() }

    fun fileOf(item: Item) = File(dir, "${item.id}__${item.name ?: "file"}")

    private fun load() {
        val loaded = runCatching {
            val arr = JSONArray(historyFile.readText())
            for (i in 0 until arr.length()) {
                val it = Item.fromJson(arr.getJSONObject(i))
                // Drop file entries whose file was removed outside the app.
                if (it.kind != "file" || fileOf(it).exists()) items.add(it)
            }
        }.isSuccess
        if (loaded) return
        // First run: rebuild the list from the files already on disk.
        val re = Regex("^([0-9a-f]{8})__(.+)$")
        for (f in dir.listFiles().orEmpty()) {
            val m = re.find(f.name) ?: continue
            items.add(Item(m.groupValues[1], "file", m.groupValues[2], f.length(), null, "earlier", "", f.lastModified()))
        }
        items.sortBy { it.ts }
    }

    private fun snapshot() = JSONArray().also { a -> items.forEach { a.put(it.toJson()) } }.toString()

    private fun scheduleSave() { // caller holds the lock
        timer?.cancel()
        val snap = snapshot()
        timer = Timer(true).also { t ->
            t.schedule(object : TimerTask() { override fun run() { runCatching { historyFile.writeText(snap) } } }, 200)
        }
    }

    @Synchronized fun all(): List<Item> = items.toList()
    @Synchronized fun find(id: String): Item? = items.firstOrNull { it.id == id }

    fun add(item: Item) {
        val dropped = ArrayList<String>()
        synchronized(this) {
            items.add(item)
            while (items.size > MAX_ITEMS) { dropped.add(items[0].id); removeLocked(items[0].id, true) }
            scheduleSave()
        }
        dropped.forEach { emit?.invoke("""{"type":"remove","id":"$it"}""") }
        emit?.invoke("""{"type":"add","item":${item.toJson()}}""")
    }

    fun remove(id: String, deleteFile: Boolean): Boolean {
        val ok = synchronized(this) { removeLocked(id, deleteFile).also { if (it) scheduleSave() } }
        if (ok) emit?.invoke("""{"type":"remove","id":"$id"}""")
        return ok
    }

    private fun removeLocked(id: String, deleteFile: Boolean): Boolean {
        val idx = items.indexOfFirst { it.id == id }
        if (idx < 0) return false
        val item = items.removeAt(idx)
        if (item.kind == "file" && deleteFile) fileOf(item).delete()
        return true
    }

    /** Writes the history now (on shutdown and in tests). */
    @Synchronized fun flush() {
        timer?.cancel()
        runCatching { historyFile.writeText(snapshot()) }
    }
}
