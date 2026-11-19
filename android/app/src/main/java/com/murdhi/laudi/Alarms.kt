package com.murdhi.laudi

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import org.json.JSONArray
import java.util.Calendar

/** Turns the dashboard's alarm list into real Android alarms (they ring even if the app is closed). */
object Alarms {
    fun schedule(c: Context, json: String) {
        Store.setAlarms(c, json)
        val am = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // cancel what we scheduled last time
        for (id in Store.scheduledIds(c)) am.cancel(pending(c, id, "", false))
        val ids = mutableSetOf<String>()
        val arr = try { JSONArray(json) } catch (e: Exception) { JSONArray() }
        for (i in 0 until arr.length()) {
            val a = arr.getJSONObject(i)
            if (!a.optBoolean("enabled", true)) continue
            val id = a.optString("id")
            val time = a.optString("time")
            val days = a.optJSONArray("days")
            val dayList = (0 until (days?.length() ?: 0)).map { days!!.getInt(it) }
            val at = next(time, dayList) ?: continue
            val label = a.optString("label", "Alarm")
            val show = PendingIntent.getActivity(c, 1, Intent(c, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            am.setAlarmClock(AlarmManager.AlarmClockInfo(at, show), pending(c, id, label, dayList.isNotEmpty()))
            ids.add(id)
        }
        Store.setScheduledIds(c, ids)
    }

    fun reschedule(c: Context) = schedule(c, Store.alarms(c))

    private fun pending(c: Context, id: String, label: String, repeat: Boolean): PendingIntent {
        val i = Intent(c, AlarmReceiver::class.java).apply {
            action = "com.murdhi.laudi.ALARM.$id"
            putExtra("id", id); putExtra("label", label); putExtra("repeat", repeat)
        }
        return PendingIntent.getBroadcast(c, id.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Next time "HH:MM" happens (on one of `days`, 0 = Sunday; empty = next occurrence). */
    fun next(time: String, days: List<Int>): Long? {
        val parts = time.split(":")
        if (parts.size != 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        val now = Calendar.getInstance()
        for (add in 0..7) {
            val c = Calendar.getInstance().apply {
                add(Calendar.DAY_OF_YEAR, add)
                set(Calendar.HOUR_OF_DAY, h); set(Calendar.MINUTE, m); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            }
            if (c.timeInMillis <= now.timeInMillis) continue
            val dow = c.get(Calendar.DAY_OF_WEEK) - 1 // 0 = Sunday
            if (days.isEmpty() || days.contains(dow)) return c.timeInMillis
        }
        return null
    }
}
