package com.ufti.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import kotlin.concurrent.thread

/**
 * The whole app is one screen: a slim top bar and a web view.
 *  - Host mode: the web view shows this phone's own UFTI page (http://localhost:8787), the same screen the Windows and
 *    iPhone apps show. Other devices scan its QR code.
 *  - Client mode: tap Scan QR, point the camera at another UFTI's QR code (Windows, iPhone or Android) and its page opens
 *    here, with native Save and Copy.
 */
class MainActivity : AppCompatActivity() {
    private val app get() = application as UFTIApp
    private val conn get() = app.connection
    private val main = Handler(Looper.getMainLooper())

    private lateinit var icon: TextView
    private lateinit var title: TextView
    private lateinit var reconnectBtn: Button
    private lateinit var scanBtn: Button
    private lateinit var disconnectBtn: Button
    private lateinit var frame: FrameLayout
    private lateinit var errorBox: LinearLayout
    private lateinit var errorText: TextView
    private lateinit var busyBox: LinearLayout
    private lateinit var busyText: TextView
    private var web: WebView? = null
    private var serverError: String? = null
    private var retries = 0

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: Pair<File, String>? = null

    private val chooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val p = pendingSave; pendingSave = null
        if (uri != null && p != null) runBackground("Saving…", { Files.copyToUri(this, p.first, uri) }) { toast("Saved ${p.second}") }
    }
    private val scanner = registerForActivityResult(ScanContract()) { r ->
        val text = r.contents
        if (text == null) {
            if (r.originalIntent?.getBooleanExtra(com.google.zxing.client.android.Intents.Scan.MISSING_CAMERA_PERMISSION, false) == true)
                alert("UFTI needs the camera to scan a QR code. Allow it in the phone's Settings, Apps, UFTI, Permissions.")
            return@registerForActivityResult
        }
        val link = RemoteLink.parse(text)
        if (link == null) alert("That isn't a UFTI pairing link. Scan the QR code UFTI shows on the PC or on another phone, on the same Wi-Fi.")
        else { conn.connect(link); rebuild() }
    }
    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // ---- UI ----
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun barButton(text: String, onClick: () -> Unit) = Button(this, null, androidx.appcompat.R.attr.borderlessButtonStyle).apply {
        this.text = text; isAllCaps = false; textSize = 13f
        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.accent))
        minWidth = 0; minimumWidth = 0; setPadding(dp(10), 0, dp(10), 0)
        setOnClickListener { onClick() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val txt = ContextCompat.getColor(this, R.color.bar_text)
        icon = TextView(this).apply { textSize = 16f; setPadding(0, 0, dp(8), 0) }
        title = TextView(this).apply { textSize = 13f; setTextColor(txt); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        reconnectBtn = barButton("Reconnect") { if (conn.reconnect()) rebuild() }
        scanBtn = barButton("Scan QR") { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Scan the QR code that UFTI shows on the PC or on another phone.").setBeepEnabled(false)
            .setOrientationLocked(false)) }
        disconnectBtn = barButton("Disconnect") { conn.disconnect(); rebuild() }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.bar_bg))
            setPadding(dp(14), dp(2), dp(4), dp(2))
            addView(icon); addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(reconnectBtn); addView(scanBtn); addView(disconnectBtn)
        }
        errorText = TextView(this).apply { gravity = Gravity.CENTER; setTextColor(txt); setPadding(dp(24), dp(8), dp(24), dp(8)) }
        errorBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; visibility = View.GONE
            addView(TextView(this@MainActivity).apply { text = "UFTI can't start its server"; textSize = 18f; setTextColor(txt); gravity = Gravity.CENTER })
            addView(errorText)
            addView(Button(this@MainActivity).apply { text = "Try again"; setOnClickListener { startServer(); rebuild() } })
        }
        busyText = TextView(this).apply { setTextColor(txt); setPadding(0, dp(10), 0, 0) }
        busyBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; visibility = View.GONE; isClickable = true
            setBackgroundColor(0x59000000)
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
                setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.bar_bg)); setPadding(dp(28), dp(22), dp(28), dp(22))
                addView(ProgressBar(this@MainActivity)); addView(busyText)
            })
        }
        frame = FrameLayout(this).apply {
            addView(errorBox, FrameLayout.LayoutParams(-1, -1))
            addView(busyBox, FrameLayout.LayoutParams(-1, -1))
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(bar, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(frame, LinearLayout.LayoutParams(-1, 0, 1f))
        })

        // The service keeps UFTI answering in the background, so back goes to the home screen instead of closing it.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { moveTaskToBack(true) }
        })
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            && !getSharedPreferences("ufti", MODE_PRIVATE).getBoolean("askedNotif", false)) {
            getSharedPreferences("ufti", MODE_PRIVATE).edit().putBoolean("askedNotif", true).apply()
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        startServer()
        rebuild()
    }

    override fun onStart() { super.onStart(); if (!app.server.isRunning) { startServer(); rebuild() } else UFTIService.start(this) }
    override fun onResume() { super.onResume(); window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    override fun onPause() { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); super.onPause() }
    override fun onDestroy() { web?.destroy(); web = null; super.onDestroy() }

    private fun startServer() {
        serverError = if (app.server.isRunning) null else app.server.start()
        if (serverError == null) UFTIService.start(this)
    }

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_LONG).show()
    private fun alert(m: String) { if (!isFinishing) AlertDialog.Builder(this).setTitle("UFTI").setMessage(m).setPositiveButton("OK", null).show() }
    private fun busy(msg: String?) { busyBox.visibility = if (msg == null) View.GONE else View.VISIBLE; busyText.text = msg ?: "" }

    /** Runs slow work off the main thread with a "busy" overlay, then reports back on the main thread. */
    private fun <T> runBackground(msg: String, work: () -> T, done: (T) -> Unit) {
        busy(msg)
        thread {
            val r = runCatching(work)
            main.post {
                busy(null)
                r.onSuccess(done).onFailure { alert("Something went wrong: ${it.message ?: "unknown error"}") }
            }
        }
    }

    // ---- the page ----
    private fun updateBar() {
        val r = conn.remote
        icon.text = if (r != null) "🔗" else "📱"
        title.text = if (r != null) "Connected to ${r.host}" else "This phone"
        reconnectBtn.visibility = if (r == null && conn.lastRemote != null) View.VISIBLE else View.GONE
        scanBtn.visibility = if (r == null) View.VISIBLE else View.GONE
        disconnectBtn.visibility = if (r != null) View.VISIBLE else View.GONE
    }

    /** Builds a fresh web view, e.g. when switching between host and client mode. */
    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun rebuild() {
        updateBar()
        retries = 0
        web?.let { frame.removeView(it); it.destroy() }
        web = null
        val isClient = conn.isClient
        errorText.text = serverError ?: ""
        errorBox.visibility = if (serverError != null && !isClient) View.VISIBLE else View.GONE
        if (serverError != null && !isClient) return

        val wv = WebView(this)
        web = wv
        frame.addView(wv, 0, FrameLayout.LayoutParams(-1, -1))
        wv.setBackgroundColor(0)
        wv.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = false
            userAgentString = "$userAgentString UFTIAndroid/${BuildConfigVersion.NAME}"
        }
        if (isClient) wv.addJavascriptInterface(Bridge(), "uftiAndroid")
        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try { chooser.launch(params.createIntent()); true } catch (e: Exception) { fileCallback = null; false }
            }
        }
        wv.webViewClient = PageClient(isClient)

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        val start = conn.startUrl()
        if (isClient) wv.loadUrl(start)
        else {
            // Host mode: sign the page in as "this phone" before loading it.
            val secret = conn.localSecret(app.server)
            cm.setCookie("http://localhost:${UFTIApp.PORT}/", "${com.ufti.android.server.Auth.COOKIE}=$secret; Path=/; Max-Age=31536000") {
                cm.flush(); wv.loadUrl(start)
            }
        }
    }

    private inner class PageClient(private val isClient: Boolean) : WebViewClient() {
        private val ownHost get() = if (isClient) conn.remote?.host else "localhost"

        override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
            val u = r.url
            if (u.host == ownHost && u.path?.startsWith("/api/file/") == true) {
                save(u.path!!.removePrefix("/api/file/"))
                return true
            }
            // Real web links open in the browser, not inside the app.
            if ((u.scheme == "http" || u.scheme == "https") && u.host != ownHost) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
            return false
        }

        override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {}

        override fun onPageFinished(v: WebView, url: String?) {
            CookieManager.getInstance().flush()
            if (!isClient) return
            conn.pairingConsumed()
            v.evaluateJavascript(COPY_BUTTON_SCRIPT, null)
        }

        override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
            if (!r.isForMainFrame) return
            if (isClient) {
                alert("Couldn't reach ${conn.remote?.host ?: "the other device"}. Make sure both devices are on the same Wi-Fi and UFTI is open there.")
                return
            }
            // Host mode: the listener may need a moment after launch; try again a few times.
            if (retries >= 20) return
            retries++
            main.postDelayed({ if (!app.server.isRunning) startServer(); web?.loadUrl(conn.startUrl()) }, 700)
        }
    }

    // ---- Save and Copy ----
    private fun isHexId(s: String) = s.length == 8 && s.all { it in '0'..'9' || it in 'a'..'f' }

    /** "Save" on a received file: it goes to Downloads/UFTI (or to a place you pick on older Android versions). */
    private fun save(id: String) {
        if (!isHexId(id)) return
        if (!conn.isClient) {
            val item = app.server.store.find(id)?.takeIf { it.kind == "file" } ?: return
            saveFile(app.server.store.fileOf(item), item.name ?: "file")
        } else {
            runBackground("Downloading…", { downloadRemote(id) }) { saveFile(it, it.name) }
        }
    }

    private fun saveFile(file: File, name: String) {
        runBackground("Saving…", { Files.saveToDownloads(this, file, name) }) { where ->
            if (where != null) toast("Saved to $where")
            else { pendingSave = file to name; createDoc.launch(name) } // Android 9 and older
        }
    }

    /** Downloads a received file from the other device, signed in with the page's own cookie. */
    private fun downloadRemote(id: String): File {
        val base = conn.remote?.base ?: throw IOException("not connected")
        val c = URL("${base}api/file/$id").openConnection() as HttpURLConnection
        c.connectTimeout = 10_000; c.readTimeout = 60_000
        CookieManager.getInstance().getCookie(base)?.let { c.setRequestProperty("Cookie", it) }
        try {
            if (c.responseCode != 200) throw IOException("the other device answered ${c.responseCode}")
            var name = "file"
            c.getHeaderField("Content-Disposition")?.let { h ->
                Regex("filename\\*=UTF-8''([^;]+)").find(h)?.groupValues?.get(1)?.let { enc ->
                    val n = runCatching { URLDecoder.decode(enc.replace("+", "%2B"), "UTF-8") }.getOrDefault(enc)
                        .substringAfterLast('/').substringAfterLast('\\')
                    if (n.isNotEmpty() && n != "..") name = n
                }
            }
            val dir = File(cacheDir, "dl").apply { deleteRecursively(); mkdirs() }
            val dest = File(dir, name)
            c.inputStream.use { i -> dest.outputStream().use { o -> i.copyTo(o, 65536) } }
            return dest
        } finally { c.disconnect() }
    }

    /** Called from the page (client mode only): the page posts a file id; the app downloads it and sets the clipboard. */
    private inner class Bridge {
        @JavascriptInterface
        fun copy(id: String) {
            if (!isHexId(id)) return
            main.post { busy("Copying…") }
            thread {
                var msg = "Could not copy. Use Save."
                runCatching { Files.copyToClipboard(this@MainActivity, downloadRemote(id)) }.getOrNull()?.let {
                    msg = if (it == "image") "Image copied. Paste it anywhere." else "File copied. Paste it into a chat or Files."
                }
                main.post { busy(null); web?.evaluateJavascript("toast(${org.json.JSONObject.quote(msg)})", null) }
            }
        }
    }

    companion object {
        /**
         * Adds a native Copy button beside each Save link. The page redraws its list often, so a MutationObserver keeps adding it.
         * Pages that already have their own Copy button (data-copyfile) are left alone. Older Windows versions need this.
         */
        const val COPY_BUTTON_SCRIPT = """
(function () {
  if (window.__uftiCopyHook) return; window.__uftiCopyHook = true;
  function add() {
    document.querySelectorAll('a[href^="/api/file/"][download]').forEach(function (a) {
      var li = a.parentElement;
      if (!li || li.querySelector('[data-copyfile],[data-nativecopy]')) return;
      var b = document.createElement('button');
      b.className = 'ghost'; b.textContent = 'Copy';
      b.title = 'Copy to the clipboard, then paste it anywhere';
      b.setAttribute('data-nativecopy', a.getAttribute('href').split('/').pop());
      a.insertAdjacentElement('afterend', b);
    });
  }
  new MutationObserver(add).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-nativecopy]');
    if (b) window.uftiAndroid.copy(b.getAttribute('data-nativecopy'));
  });
  add();
})();
"""
    }
}

/** Kept apart so the version string is in one place. */
object BuildConfigVersion { const val NAME = "1.0" }
