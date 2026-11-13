package com.ufti.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object Files {
    fun mimeOf(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    /** Stored files are named `<id>__<name>`; show only the name. */
    fun displayName(f: File): String = Regex("^[0-9a-f]{8}__(.+)$").find(f.name)?.groupValues?.get(1) ?: f.name

    /**
     * Puts a file on the clipboard: images as an image, anything else as a file. Returns "image" or "file", or null.
     * Safe to call from any thread (the clipboard is touched on the main thread).
     */
    fun copyToClipboard(ctx: Context, file: File): String? {
        var result: String? = null
        val done = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            try {
                val dir = File(ctx.cacheDir, "clip").apply { deleteRecursively(); mkdirs() }
                val name = displayName(file)
                val copy = File(dir, name)
                file.copyTo(copy, overwrite = true) // a clean file name for the app that pastes it
                val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", copy)
                val mime = mimeOf(name)
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData(name, arrayOf(mime), ClipData.Item(uri)))
                result = if (mime.startsWith("image/")) "image" else "file"
            } catch (_: Exception) {
            } finally { done.countDown() }
        }
        done.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Saves a file to Downloads/UFTI. Returns where it went, or null when this Android version needs the file picker instead. */
    fun saveToDownloads(ctx: Context, src: File, name: String): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val cr = ctx.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mimeOf(name))
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/UFTI")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw java.io.IOException("insert failed")
        try {
            cr.openOutputStream(uri)!!.use { out -> src.inputStream().use { it.copyTo(out, 65536) } }
            cr.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) { cr.delete(uri, null, null); throw e }
        return "Downloads/UFTI/$name"
    }

    fun copyToUri(ctx: Context, src: File, dest: Uri) {
        ctx.contentResolver.openOutputStream(dest)!!.use { out -> src.inputStream().use { it.copyTo(out, 65536) } }
    }
}
