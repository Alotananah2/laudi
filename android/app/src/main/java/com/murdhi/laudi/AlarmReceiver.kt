package com.murdhi.laudi

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.json.JSONArray

/** An alarm went off: show the full-screen ringing screen (also over the lock screen). */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: ""
        val label = intent.getStringExtra("label") ?: "Alarm"
        val repeat = intent.getBooleanExtra("repeat", false)
        ring(c, label)
        // one-time alarms switch off; repeating ones get their next day scheduled
        if (!repeat && id != "snooze") {
            try {
                val arr = JSONArray(Store.alarms(c))
                for (i in 0 until arr.length()) if (arr.getJSONObject(i).optString("id") == id) arr.getJSONObject(i).put("enabled", false)
                Store.setAlarms(c, arr.toString())
            } catch (_: Exception) {}
        }
        Alarms.reschedule(c)
    }

    companion object {
        const val CHANNEL = "alarms"
        const val NOTIF_ID = 4242

        fun ring(c: Context, label: String) {
            val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL) == null) {
                val ch = NotificationChannel(CHANNEL, "Alarms", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Laudi alarms"
                    setSound(null, null) // the alarm screen plays the sound
                    enableVibration(true)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
                nm.createNotificationChannel(ch)
            }
            val open = Intent(c, AlarmActivity::class.java).apply {
                putExtra("label", label)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            }
            val full = PendingIntent.getActivity(c, 7, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val n = NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("⏰ $label")
                .setContentText("Tap to stop")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setFullScreenIntent(full, true)
                .setContentIntent(full)
                .setOngoing(true)
                .build()
            nm.notify(NOTIF_ID, n)
            try { c.startActivity(open) } catch (_: Exception) {}
        }
    }
}
