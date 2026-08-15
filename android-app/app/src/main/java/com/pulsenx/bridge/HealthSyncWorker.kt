package com.pulsenx.bridge

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * WorkManager driver for the "Google Fit mirror sync" — see [HealthMirror] for the
 * actual engine and the rationale (Google Fit's third-party APIs are closed; mirroring
 * Huawei-origin Health Connect records under the PulseNX origin is the durable path).
 *
 * 15 minutes is WorkManager's hard floor for periodic work, so this job is the
 * BACKSTOP: it keeps the mirror moving when the bridge service is dead. While the
 * foreground service is alive it drives the same engine every 5 minutes, and the
 * shared mutex in [HealthMirror] keeps the two drivers from overlapping.
 */
class HealthSyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "PulseNX/HealthSync"

        const val WORK_NAME = "pulsenx-health-mirror"
        private const val INTERVAL_MINUTES = 15L

        fun enqueue(context: Context) {
            try {
                val request = PeriodicWorkRequestBuilder<HealthSyncWorker>(
                    INTERVAL_MINUTES, TimeUnit.MINUTES
                ).build()
                WorkManager.getInstance(context.applicationContext)
                    .enqueueUniquePeriodicWork(
                        WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request
                    )
                Log.d(TAG, "mirror sync enqueued")
            } catch (e: Exception) {
                Log.e(TAG, "enqueue failed", e)
            }
        }

        fun cancel(context: Context) {
            try {
                WorkManager.getInstance(context.applicationContext)
                    .cancelUniqueWork(WORK_NAME)
                // Drop the incremental cursor so a re-enable backfills cleanly.
                context.getSharedPreferences(VitalsBridgeService.PREFS, Context.MODE_PRIVATE)
                    .edit().remove(VitalsBridgeService.KEY_MIRROR_TOKEN).apply()
                Log.d(TAG, "mirror sync cancelled")
            } catch (e: Exception) {
                Log.e(TAG, "cancel failed", e)
            }
        }
    }

    override suspend fun doWork(): Result = try {
        HealthMirror.sync(applicationContext)
        Result.success()
    } catch (e: Exception) {
        Log.e(TAG, "mirror run failed", e)
        Result.retry()
    }
}
