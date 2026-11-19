package com.murdhi.laudi

import android.content.Context

/** Saved server address, login token and the last alarm list (for rescheduling after a reboot). */
object Store {
    private fun p(c: Context) = c.getSharedPreferences("laudi", Context.MODE_PRIVATE)
    fun server(c: Context): String = p(c).getString("server", "") ?: ""
    fun setServer(c: Context, v: String) = p(c).edit().putString("server", v.trim().trimEnd('/')).apply()
    fun token(c: Context): String = p(c).getString("token", "") ?: ""
    fun setToken(c: Context, v: String) = p(c).edit().putString("token", v).apply()
    fun alarms(c: Context): String = p(c).getString("alarms", "[]") ?: "[]"
    fun setAlarms(c: Context, v: String) = p(c).edit().putString("alarms", v).apply()
    fun scheduledIds(c: Context): Set<String> = p(c).getStringSet("ids", emptySet()) ?: emptySet()
    fun setScheduledIds(c: Context, v: Set<String>) = p(c).edit().putStringSet("ids", v).apply()
}
