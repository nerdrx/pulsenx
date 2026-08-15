package com.pulsenx.bridge

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * The "Huawei Health" heart-rate source: a polling reader over Health Connect that
 * behaves, from the service's point of view, exactly like the BLE GATT notifications.
 *
 * Huawei Health flushes its watch samples into Health Connect in bursts, so a poll
 * every 30 s over a slightly overlapping window (2 min back) catches late arrivals
 * without ever re-emitting a sample we already forwarded.
 */
class HealthConnectSource(
    private val context: Context,
    private val scope: CoroutineScope,
    /** Called once per newly seen sample, oldest first. */
    private val onSample: (bpm: Int, tsMs: Long) -> Unit,
    /** Null = healthy, otherwise a user-visible reason the source is not producing. */
    private val onStatus: (error: String?) -> Unit
) {

    private companion object {
        const val TAG = "PulseNX/HealthSrc"
        const val POLL_INTERVAL_MS = 30_000L
        const val OVERLAP_MS = 120_000L
        /** On a cold start only look a few minutes back, not at the whole day. */
        const val COLD_START_MS = 300_000L
        const val PAGE_SIZE = 1000
    }

    private var job: Job? = null

    /** Epoch ms of the newest sample handed to [onSample]; 0 until the first one. */
    @Volatile
    var lastEmittedTs = 0L
        private set

    fun start() {
        if (job != null) return
        Log.d(TAG, "starting Health Connect polling source")
        job = scope.launch {
            while (isActive) {
                pollOnce()
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    fun stop() {
        Log.d(TAG, "stopping Health Connect polling source")
        job?.cancel()
        job = null
        lastEmittedTs = 0L
    }

    val isRunning: Boolean get() = job?.isActive == true

    // ==================================================================
    // Polling
    // ==================================================================

    private suspend fun pollOnce() {
        when (HealthConnectHub.sdkStatus(context)) {
            HealthConnectClient.SDK_UNAVAILABLE -> {
                onStatus(context.getString(R.string.health_src_missing))
                return
            }

            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                onStatus(context.getString(R.string.health_src_update))
                return
            }
        }

        val client = HealthConnectHub.client(context)
        if (client == null) {
            onStatus(context.getString(R.string.health_src_missing))
            return
        }

        try {
            if (!HealthConnectHub.grantedPermissions(context)
                    .contains(HealthConnectHub.READ_HEART_RATE)
            ) {
                onStatus(context.getString(R.string.health_src_permission))
                return
            }

            val now = Instant.now()
            val start = if (lastEmittedTs > 0L) {
                Instant.ofEpochMilli(lastEmittedTs - OVERLAP_MS)
            } else {
                now.minusMillis(COLD_START_MS)
            }

            val fresh = ArrayList<Pair<Long, Int>>()
            var pageToken: String? = null
            do {
                val response = client.readRecords(
                    ReadRecordsRequest(
                        recordType = HeartRateRecord::class,
                        timeRangeFilter = TimeRangeFilter.between(start, now),
                        ascendingOrder = true,
                        pageSize = PAGE_SIZE,
                        pageToken = pageToken
                    )
                )
                for (record in response.records) {
                    for (sample in record.samples) {
                        val ts = sample.time.toEpochMilli()
                        if (ts > lastEmittedTs) fresh += ts to sample.beatsPerMinute.toInt()
                    }
                }
                pageToken = response.pageToken
            } while (pageToken != null)

            onStatus(null)
            if (fresh.isEmpty()) return

            // Strictly increasing order, and de-duped in case two records overlap.
            fresh.sortBy { it.first }
            var previousTs = lastEmittedTs
            for ((ts, bpm) in fresh) {
                if (ts <= previousTs || bpm <= 0) continue
                previousTs = ts
                lastEmittedTs = ts
                onSample(bpm, ts)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "read denied: ${e.message}")
            onStatus(context.getString(R.string.health_src_permission))
        } catch (e: Exception) {
            Log.w(TAG, "poll failed: ${e.message}")
            onStatus(context.getString(R.string.health_src_error))
        }
    }
}
