package com.ufti.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps UFTI answering while the app is in the background or the screen is off, the way the Windows app does from the tray.
 * (iOS suspends background apps; Android lets a foreground service with a visible notification keep running.)
 * The CPU and Wi-Fi are held awake only while a transfer is under way.
 */
class UFTIService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "UFTI is running", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, UFTIService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("UFTI is ready")
            .setContentText("Other devices can send files to this phone. Tap to open.")
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .setOngoing(true)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, 1, n, type)

        val app = application as UFTIApp
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ufti:transfer").apply { setReferenceCounted(false) }
        wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "ufti:transfer").apply { setReferenceCounted(false) }
        app.server.onBusy = { busy -> setAwake(busy) }
    }

    /** Holds the CPU and Wi-Fi awake while a transfer is under way. */
    private fun setAwake(on: Boolean) {
        try {
            if (on) {
                wake?.acquire(30 * 60_000L)
                wifi?.acquire()
            } else {
                releaseLocks()
            }
        } catch (_: RuntimeException) {
        }
    }

    private fun releaseLocks() {
        if (wake?.isHeld == true) wake?.release()
        if (wifi?.isHeld == true) wifi?.release()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            (application as UFTIApp).server.stop()
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        (application as UFTIApp).server.onBusy = null
        try { releaseLocks() } catch (_: RuntimeException) { }
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "ufti_running"
        const val ACTION_STOP = "com.ufti.android.STOP"
        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, UFTIService::class.java))
    }
}
