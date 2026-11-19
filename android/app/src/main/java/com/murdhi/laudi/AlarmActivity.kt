package com.murdhi.laudi

import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The ringing screen: big time, Stop and Snooze. Plays the alarm sound until you stop it. */
class AlarmActivity : Activity() {
    private var player: MediaPlayer? = null
    private var vib: Vibrator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        @Suppress("DEPRECATION")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        val label = intent.getStringExtra("label") ?: "Alarm"

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(Color.parseColor("#4F46E5"), Color.parseColor("#9333EA"), Color.parseColor("#0B0B14")))
            setPadding(60, 60, 60, 60)
        }
        fun text(t: String, size: Float, bold: Boolean = false) = TextView(this).apply {
            text = t; textSize = size; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            if (bold) typeface = Typeface.DEFAULT_BOLD
        }
        root.addView(text("⏰", 64f))
        root.addView(text(SimpleDateFormat("h:mm", Locale.getDefault()).format(Date()), 84f))
        root.addView(text(label, 26f, true))
        root.addView(text("Laudi is calling you too 📞", 15f).apply { alpha = 0.75f; setPadding(0, 16, 0, 60) })
        fun button(t: String, color: String, onClick: () -> Unit) = Button(this).apply {
            text = t; textSize = 20f; setTextColor(Color.WHITE); isAllCaps = false
            background = GradientDrawable().apply { cornerRadius = 80f; setColor(Color.parseColor(color)) }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 170).apply { setMargins(0, 18, 0, 18) }
            setOnClickListener { onClick() }
        }
        root.addView(button("Stop", "#DC2626") { stop() })
        root.addView(button("Snooze 5 min", "#33FFFFFF") { snooze(label) })
        setContentView(root)
        startSound()
    }

    private fun startSound() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            player = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(this@AlarmActivity, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Exception) {}
        try {
            @Suppress("DEPRECATION")
            vib = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            vib?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0))
        } catch (_: Exception) {}
    }

    private fun quiet() {
        try { player?.stop(); player?.release() } catch (_: Exception) {}
        player = null
        try { vib?.cancel() } catch (_: Exception) {}
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(AlarmReceiver.NOTIF_ID)
    }

    private fun stop() { quiet(); finish() }

    private fun snooze(label: String) {
        quiet()
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val i = Intent(this, AlarmReceiver::class.java).apply { action = "com.murdhi.laudi.ALARM.snooze"; putExtra("id", "snooze"); putExtra("label", label) }
        val pi = PendingIntent.getBroadcast(this, 999, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val show = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        am.setAlarmClock(AlarmManager.AlarmClockInfo(System.currentTimeMillis() + 5 * 60_000, show), pi)
        finish()
    }

    override fun onDestroy() { quiet(); super.onDestroy() }
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { /* must press Stop or Snooze */ }
}
