package com.murdhi.laudi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Phone restarted / time changed: put the alarms back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) = Alarms.reschedule(c)
}
