package com.pulsenx.bridge

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.roundToLong
import kotlin.reflect.KClass

/**
 * The daily roll-up the PC dashboard renders. Every field is nullable: a phone with
 * only a heart-rate feed still produces a valid (mostly empty) summary.
 */
data class HealthSummary(
    val ts: Long,
    val steps: Long?,
    val distanceKm: Double?,
    val activeKcal: Double?,
    val totalKcal: Double?,
    val sleepMin: Long?,
    val restingBpm: Int?,
    val minBpm: Int?,
    val avgBpm: Int?,
    val maxBpm: Int?,
    val spo2Pct: Double?,
    val source: String
) {

    /** The exact `{"type":"health", ...}` frame from the protocol contract. */
    fun toMessageJson(): String {
        val summary = JSONObject().apply {
            putOrNull("steps", steps)
            putOrNull("distanceKm", distanceKm)
            putOrNull("activeKcal", activeKcal)
            putOrNull("totalKcal", totalKcal)
            putOrNull("sleepMin", sleepMin)
            putOrNull("restingBpm", restingBpm)
            putOrNull("minBpm", minBpm)
            putOrNull("avgBpm", avgBpm)
            putOrNull("maxBpm", maxBpm)
            putOrNull("spo2Pct", spo2Pct)
            put("source", source)
        }
        return JSONObject().apply {
            put("type", "health")
            put("ts", ts)
            put("summary", summary)
        }.toString()
    }

    /** `put(key, null)` *removes* the key on org.json — we want an explicit JSON null. */
    private fun JSONObject.putOrNull(key: String, value: Any?) {
        put(key, value ?: JSONObject.NULL)
    }
}

/**
 * Reads today's health roll-up out of Health Connect.
 *
 * Each metric is fetched in its own try/catch: Health Connect throws when the app is
 * missing the read permission for *any* metric in an aggregate request, and users
 * routinely grant permissions one checkbox at a time.
 */
object HealthSummaryReader {

    private const val TAG = "PulseNX/HealthSum"
    private const val SLEEP_WINDOW_HOURS = 24L
    /** Sleep sessions can start well before the window; widen the read, filter after. */
    private const val SLEEP_LOOKBACK_HOURS = 48L

    suspend fun read(context: Context): HealthSummary? {
        val client = HealthConnectHub.client(context) ?: return null

        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        val midnight = LocalDate.now(zone).atStartOfDay(zone).toInstant()
        val today = TimeRangeFilter.between(midnight, now)
        val lastDay = TimeRangeFilter.between(now.minus(Duration.ofHours(SLEEP_WINDOW_HOURS)), now)

        // Every dataOrigin we touched — decides "huawei" vs "healthconnect".
        val origins = HashSet<String>()

        val steps = aggregate(client, StepsRecord.COUNT_TOTAL, today, origins)
        val distanceKm = aggregate(client, DistanceRecord.DISTANCE_TOTAL, today, origins)
            ?.inKilometers?.round(2)
        val activeKcal = aggregate(client, ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL, today, origins)
            ?.inKilocalories?.round(1)
        val totalKcal = aggregate(client, TotalCaloriesBurnedRecord.ENERGY_TOTAL, today, origins)
            ?.inKilocalories?.round(1)

        // The three BPM aggregates share one request: they share one permission too.
        var minBpm: Int? = null
        var avgBpm: Int? = null
        var maxBpm: Int? = null
        try {
            val hr = client.aggregate(
                AggregateRequest(
                    metrics = setOf(
                        HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MAX
                    ),
                    timeRangeFilter = today
                )
            )
            collectOrigins(hr, origins)
            minBpm = hr[HeartRateRecord.BPM_MIN]?.toInt()
            avgBpm = hr[HeartRateRecord.BPM_AVG]?.toInt()
            maxBpm = hr[HeartRateRecord.BPM_MAX]?.toInt()
        } catch (e: Exception) {
            Log.d(TAG, "HR aggregate unavailable: ${e.message}")
        }

        val sleepMin = readSleepMinutes(client, now, origins)

        val restingBpm = latest(client, RestingHeartRateRecord::class, lastDay, origins) { it.time }
            ?.beatsPerMinute?.toInt()

        val spo2Pct = latest(client, OxygenSaturationRecord::class, lastDay, origins) { it.time }
            ?.percentage?.value?.round(1)

        val source = if (origins.any { it.contains("huawei", ignoreCase = true) }) {
            "huawei"
        } else {
            "healthconnect"
        }

        return HealthSummary(
            ts = System.currentTimeMillis(),
            steps = steps,
            distanceKm = distanceKm,
            activeKcal = activeKcal,
            totalKcal = totalKcal,
            sleepMin = sleepMin,
            restingBpm = restingBpm,
            minBpm = minBpm,
            avgBpm = avgBpm,
            maxBpm = maxBpm,
            spo2Pct = spo2Pct,
            source = source
        )
    }

    // ==================================================================
    // Building blocks
    // ==================================================================

    private suspend fun <T : Any> aggregate(
        client: HealthConnectClient,
        metric: AggregateMetric<T>,
        range: TimeRangeFilter,
        origins: MutableSet<String>
    ): T? = try {
        val result = client.aggregate(AggregateRequest(setOf(metric), range))
        collectOrigins(result, origins)
        result[metric]
    } catch (e: Exception) {
        Log.d(TAG, "aggregate unavailable: ${e.message}")
        null
    }

    /**
     * Total minutes of every sleep session that overlaps the last 24 h. Read as records
     * rather than aggregated so a session that started yesterday evening counts in full.
     */
    private suspend fun readSleepMinutes(
        client: HealthConnectClient,
        now: Instant,
        origins: MutableSet<String>
    ): Long? = try {
        val windowStart = now.minus(Duration.ofHours(SLEEP_WINDOW_HOURS))
        val sessions = client.readRecords(
            ReadRecordsRequest(
                recordType = SleepSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(
                    now.minus(Duration.ofHours(SLEEP_LOOKBACK_HOURS)), now
                ),
                ascendingOrder = true
            )
        ).records.filter { it.endTime.isAfter(windowStart) }

        sessions.forEach { origins += it.metadata.dataOrigin.packageName }
        if (sessions.isEmpty()) null
        else sessions.sumOf { Duration.between(it.startTime, it.endTime).toMinutes() }
    } catch (e: Exception) {
        Log.d(TAG, "sleep read unavailable: ${e.message}")
        null
    }

    /** Newest record of [type] inside [range], or null when there is none / no access. */
    private suspend fun <T : Record> latest(
        client: HealthConnectClient,
        type: KClass<T>,
        range: TimeRangeFilter,
        origins: MutableSet<String>,
        timeOf: (T) -> Instant
    ): T? = try {
        val records = client.readRecords(
            ReadRecordsRequest(recordType = type, timeRangeFilter = range, ascendingOrder = true)
        ).records
        records.forEach { origins += it.metadata.dataOrigin.packageName }
        records.maxByOrNull { timeOf(it).toEpochMilli() }
    } catch (e: Exception) {
        Log.d(TAG, "${type.simpleName} read unavailable: ${e.message}")
        null
    }

    private fun collectOrigins(result: AggregationResult, into: MutableSet<String>) {
        result.dataOrigins.forEach { into += it.packageName }
    }

    private fun Double.round(decimals: Int): Double {
        var factor = 1.0
        repeat(decimals) { factor *= 10 }
        return (this * factor).roundToLong() / factor
    }
}
