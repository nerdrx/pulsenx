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

    /** The two values the protocol's `summary.source` field may carry. */
    const val SOURCE_HUAWEI = "huawei"
    const val SOURCE_HEALTH_CONNECT = "healthconnect"

    private const val SLEEP_WINDOW_HOURS = 24L
    /** Sleep sessions can start well before the window; widen the read, filter after. */
    private const val SLEEP_LOOKBACK_HOURS = 48L

    /**
     * The summary the bridge actually ships: Health Connect, plus the Huawei Health
     * **cloud** roll-up when that account is linked.
     *
     * Order matters only for the write-back: the cloud read happens first so its
     * aggregates can be mirrored into Health Connect (when the mirror toggle is on)
     * before anything is sent to the PC.
     *
     * @param includeHealthConnect false when the caller already knows Health Connect
     *        is missing or unpermitted — the cloud alone still makes a valid summary.
     */
    suspend fun readCombined(context: Context, includeHealthConnect: Boolean = true): HealthSummary? {
        val huawei = try {
            HuaweiKitReader.readDaily(context)
        } catch (e: Exception) {
            Log.w(TAG, "Huawei cloud read failed: ${e.message}")
            null
        }

        if (huawei != null) {
            try {
                HealthMirror.writeHuaweiCloudDaily(context, huawei)
            } catch (e: Exception) {
                Log.w(TAG, "Huawei cloud write-back failed: ${e.message}")
            }
        }

        val healthConnect = if (!includeHealthConnect) null else try {
            read(context)
        } catch (e: Exception) {
            Log.w(TAG, "Health Connect read failed: ${e.message}")
            null
        }

        return merge(healthConnect, huawei)
    }

    /**
     * Pure merge of the two sources. Neither is a superset of the other, so:
     *
     * | field                       | rule |
     * |-----------------------------|------|
     * | steps, distance, kcal, sleep | the LARGER of the two |
     * | minBpm / maxBpm              | the true min / max across both |
     * | avgBpm                       | Health Connect wins (averages cannot be combined) |
     * | restingBpm, spo2Pct          | Health Connect wins, Huawei fills the gap |
     *
     * Why *larger* and not a sum for the cumulative totals: on a GMS phone Health
     * Connect sees the phone's own pedometer (and, when the mirror is on, PulseNX's
     * own copies of these very cloud aggregates), while Huawei's cloud sees the
     * watch. Summing would double-count the overlap outright; taking the maximum
     * cannot — worst case it under-reports by whatever one source saw and the other
     * did not, which is the honest failure direction for a health readout.
     *
     * [HealthSummary.source] becomes "huawei" as soon as any cloud value survived
     * into the result, which is exactly what the PC's `via Huawei Health` chip means.
     */
    fun merge(hc: HealthSummary?, hw: HuaweiDaily?): HealthSummary? {
        if (hw == null || !hw.hasAnyValue) return hc
        if (hc == null) {
            return HealthSummary(
                ts = hw.ts,
                steps = hw.steps,
                distanceKm = hw.distanceKm,
                activeKcal = hw.activeKcal,
                totalKcal = hw.totalKcal,
                sleepMin = hw.sleepMin,
                restingBpm = hw.restingBpm,
                minBpm = hw.minBpm,
                avgBpm = hw.avgBpm,
                maxBpm = hw.maxBpm,
                spo2Pct = hw.spo2Pct,
                source = SOURCE_HUAWEI
            )
        }

        var cloudContributed = false
        fun <T : Comparable<T>> larger(a: T?, b: T?): T? = when {
            a == null -> b?.also { cloudContributed = true }
            b == null -> a
            b > a -> b.also { cloudContributed = true }
            else -> a
        }

        fun <T : Comparable<T>> smaller(a: T?, b: T?): T? = when {
            a == null -> b?.also { cloudContributed = true }
            b == null -> a
            b < a -> b.also { cloudContributed = true }
            else -> a
        }

        fun <T> fillGap(a: T?, b: T?): T? = a ?: b?.also { cloudContributed = true }

        val merged = HealthSummary(
            ts = System.currentTimeMillis(),
            steps = larger(hc.steps, hw.steps),
            distanceKm = larger(hc.distanceKm, hw.distanceKm),
            activeKcal = larger(hc.activeKcal, hw.activeKcal),
            totalKcal = larger(hc.totalKcal, hw.totalKcal),
            sleepMin = larger(hc.sleepMin, hw.sleepMin),
            restingBpm = fillGap(hc.restingBpm, hw.restingBpm),
            minBpm = smaller(hc.minBpm, hw.minBpm),
            avgBpm = fillGap(hc.avgBpm, hw.avgBpm),
            maxBpm = larger(hc.maxBpm, hw.maxBpm),
            spo2Pct = fillGap(hc.spo2Pct, hw.spo2Pct),
            source = hc.source
        )
        return if (cloudContributed) merged.copy(source = SOURCE_HUAWEI) else merged
    }

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

        val restingBpm = latest(client, RestingHeartRateRecord::class, lastDay, origins)
            ?.beatsPerMinute?.toInt()

        val spo2Pct = latest(client, OxygenSaturationRecord::class, lastDay, origins)
            ?.percentage?.value?.round(1)

        val source = if (origins.any { it.contains("huawei", ignoreCase = true) }) {
            SOURCE_HUAWEI
        } else {
            SOURCE_HEALTH_CONNECT
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
        val range = TimeRangeFilter.between(
            now.minus(Duration.ofHours(SLEEP_LOOKBACK_HOURS)), now
        )
        val sessions = buildList {
            var pageToken: String? = null
            do {
                val response = client.readRecords(
                    ReadRecordsRequest(
                        recordType = SleepSessionRecord::class,
                        timeRangeFilter = range,
                        ascendingOrder = true,
                        pageToken = pageToken
                    )
                )
                addAll(response.records)
                pageToken = response.pageToken
            } while (pageToken != null)
        }.filter { it.endTime.isAfter(windowStart) }

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
        origins: MutableSet<String>
    ): T? = try {
        val records = client.readRecords(
            ReadRecordsRequest(
                recordType = type,
                timeRangeFilter = range,
                ascendingOrder = false,
                pageSize = 1
            )
        ).records
        records.forEach { origins += it.metadata.dataOrigin.packageName }
        records.firstOrNull()
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
