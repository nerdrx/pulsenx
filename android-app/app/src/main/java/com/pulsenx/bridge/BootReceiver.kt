package com.pulsenx.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Brings the bridge back up after a reboot so the PC link survives power cycles. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) return

        val serviceIntent = Intent(context, VitalsBridgeService::class.java)
        try {
            context.startForegroundService(serviceIntent)
        } catch (_: Exception) {
            try {
                context.startService(serviceIntent)
            } catch (_: Exception) {
            }
        }
    }
}
