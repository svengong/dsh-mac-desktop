package com.deepseek.harness.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.deepseek.harness.android.MainActivity
import com.deepseek.harness.android.R

/**
 * Keeps the process alive while a harness connection is up.
 *
 * An SSH forward is owned by the app process: once Android freezes or kills the
 * app in the background, the tunnel dies with it and the user comes back to a
 * dead page. A foreground service with a persistent notification is the
 * platform-blessed way to say "this is doing work the user asked for", and it
 * makes a network switch recoverable instead of terminal.
 *
 * It holds no connection state of its own — the [com.deepseek.harness.android.connection.ConnectionManager]
 * is the single owner. This service is only a lifetime anchor plus a status
 * surface.
 */
class HarnessConnectionService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val detail = intent?.getStringExtra(EXTRA_DETAIL).orEmpty()
        createChannel()
        val notification = buildNotification(detail)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // Not sticky: a restarted process has no tunnel and no session, so
        // resuming this service alone would show a notification for nothing.
        return START_NOT_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
                description = "保持与终端的连接，避免切到后台后隧道断开"
            }
        )
    }

    private fun buildNotification(detail: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("DeepSeek Harness 已连接")
            .setContentText(detail.ifBlank { "隧道保持中" })
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "dsh-connection"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_STOP = "com.deepseek.harness.android.STOP"

        fun start(context: Context, detail: String = "") {
            val intent = Intent(context, HarnessConnectionService::class.java)
                .putExtra(EXTRA_DETAIL, detail)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, HarnessConnectionService::class.java))
        }

        private const val EXTRA_DETAIL = "detail"
    }
}
