package com.pulsenx.bridge

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Today's roll-up as Huawei's cloud sees it. Every field is nullable — a scope the
 * console never approved, or a metric the watch does not record, simply stays null
 * and the merge in [HealthSummaryReader] leaves Health Connect's value in place.
 */
data class HuaweiDaily(
    val ts: Long,
    val steps: Long?,
    val distanceKm: Double?,
    val activeKcal: Double?,
    val totalKcal: Double?,
    val sleepMin: Long?,
    /** Fall-asleep / wake-up of the newest sleep record, epoch ms — for the HC write-back. */
    val sleepStartMs: Long?,
    val sleepEndMs: Long?,
    val restingBpm: Int?,
    val minBpm: Int?,
    val avgBpm: Int?,
    val maxBpm: Int?,
    val spo2Pct: Double?
) {
    /** False when the cloud answered but had nothing to say — nothing to merge, then. */
    val hasAnyValue: Boolean
        get() = steps != null || distanceKm != null || activeKcal != null || totalKcal != null ||
            sleepMin != null || restingBpm != null || minBpm != null || avgBpm != null ||
            maxBpm != null || spo2Pct != null
}

/**
 * Reads the daily aggregates out of the Huawei Health Kit **cloud** REST API.
 *
 * Endpoints, verified against the official reference (doc pages last updated
 * 2026-05-13, read 2026-08):
 *
 *  - `POST /healthkit/v2/sampleSet:dailyPolymerize`
 *    body `{dataTypes:[...], startDay:"yyyyMMdd", endDay:"yyyyMMdd", timeZone:"+0200"}`
 *    → `{group:[{startTime,endTime,sampleSet:[{dataCollectorId,samplePoints:[
 *         {startTime,endTime,dataTypeName,value:[{fieldName,integerValue|floatValue|longValue}]}]}]}]}`
 *    https://developer.huawei.com/consumer/en/doc/HMSCore-References/sampleset_daily_polymerize-0000001078113560
 *    NOTE the asymmetry the docs are explicit about: request days are calendar strings,
 *    group start/end are **milliseconds**, sample-point start/end are **nanoseconds**
 *    (data model: https://developer.huawei.com/consumer/en/doc/HMSCore-References/data-model-0000001054556973).
 *
 *  - `GET /healthkit/v2/healthRecords?startTime=<ns>&endTime=<ns>&dataType=...`
 *    → `{healthRecords:[{startTime,endTime,dataTypeName,value:[{fieldName,...}],id}]}`
 *    https://developer.huawei.com/consumer/en/doc/HMSCore-References/get-health-record-by-datatype-0000001142843917
 *
 * Data types and their fields (each from its own cloud-side data-type doc page):
 *
 * | request type (detail)                       | response type (statistics)                      | fields |
 * |---------------------------------------------|-------------------------------------------------|--------|
 * | com.huawei.continuous.steps.delta            | com.huawei.continuous.steps.total               | steps (int), duration (min) |
 * | com.huawei.continuous.distance.delta         | com.huawei.continuous.distance.total            | distance (float, METRES) |
 * | com.huawei.continuous.calories.burnt         | com.huawei.continuous.calories.burnt.total      | calories_total (float, kcal) |
 * | com.huawei.instantaneous.heart_rate          | com.huawei.continuous.heart_rate.statistics     | avg, max, min, last (float bpm) |
 * | com.huawei.instantaneous.resting_heart_rate  | com.huawei.continuous.resting_heart_rate.statistics | avg, max, min, last |
 * | com.huawei.instantaneous.spo2                | com.huawei.continuous.spo2.statistics           | saturation_avg/_max/_min/_last (%) |
 * | com.huawei.health.record.sleep (health record)| —                                              | all_sleep_time (min), fall_asleep_time / wakeup_time (ms) |
 *
 * The parsers below are deliberately structural rather than positional: they walk
 * every group / sampleSet / samplePoint and pick values out by `dataTypeName` +
 * `fieldName`, so an extra grouping level or a renamed collector cannot break them.
 * Where the docs are silent (e.g. whether a single-day query ever returns more than
 * one group) the code sums / min-maxes across whatever it gets.
 */
object HuaweiKitReader {

    private const val TAG = "PulseNX/HuaweiKit"

    private const val DAILY_URL = "${HuaweiCloud.API_BASE}/healthkit/v2/sampleSet:dailyPolymerize"
    private const val RECORDS_URL = "${HuaweiCloud.API_BASE}/healthkit/v2/healthRecords"

    // Detail (request) data types.
    const val DT_STEPS = "com.huawei.continuous.steps.delta"
    const val DT_DISTANCE = "com.huawei.continuous.distance.delta"
    const val DT_CALORIES = "com.huawei.continuous.calories.burnt"
    const val DT_HEART_RATE = "com.huawei.instantaneous.heart_rate"
    const val DT_RESTING_HR = "com.huawei.instantaneous.resting_heart_rate"
    const val DT_SPO2 = "com.huawei.instantaneous.spo2"
    const val DT_SLEEP_RECORD = "com.huawei.health.record.sleep"

    /** Sleep sessions counted as "last night": anything overlapping the last 24 h. */
    private const val SLEEP_WINDOW_HOURS = 24L
    /** …read from a wider window, because a session starts before it ends. */
    private const val SLEEP_LOOKBACK_HOURS = 48L

    private val DAY_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd")

    /**
     * One pass over every metric. Null when the account is not linked; otherwise a
     * (possibly all-null) [HuaweiDaily]. Each metric is fetched in its own guarded
     * step, exactly like [HealthSummaryReader]: a scope the console never approved
     * answers 403 and must not take the other five metrics down with it.
     */
    suspend fun readDaily(context: Context): HuaweiDaily? {
        if (!HuaweiCloud.isLinked(context)) return null

        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        val day = LocalDate.now(zone).format(DAY_FORMAT)
        val tz = zoneOffsetString(zone, now)

        // Steps / distance / calories share the console's "Activity data" scope group,
        // so they normally succeed or fail together and one round-trip is enough.
        // If the batch fails, each type is retried alone: a single unapproved scope
        // makes the whole batch 403, and the other two are still worth having.
        var activity = dailyStats(context, listOf(DT_STEPS, DT_DISTANCE, DT_CALORIES), day, tz)
        if (activity == null) {
            Log.d(TAG, "activity batch failed, retrying the three types individually")
            val merged = ArrayList<TypedPoint>()
            for (type in listOf(DT_STEPS, DT_DISTANCE, DT_CALORIES)) {
                dailyStats(context, listOf(type), day, tz)?.let { merged += it }
            }
            activity = if (merged.isEmpty()) null else merged
        }

        val hr = dailyStats(context, listOf(DT_HEART_RATE), day, tz)
        val restingHr = dailyStats(context, listOf(DT_RESTING_HR), day, tz)
        val spo2 = dailyStats(context, listOf(DT_SPO2), day, tz)
        val sleep = readSleep(context, now)

        // Field-name fallbacks throughout: the docs say dailyPolymerize answers with the
        // *statistical* type ("steps", "distance", "calories_total", "avg"/"min"/"max",
        // "saturation_*"), but they never promise it, and a day with a single raw sample
        // could plausibly come back as the detail type instead. Trying the detail field
        // second costs nothing and turns a silent null into a real number.
        val distanceMetres = activity
            ?.let { sumAny(it, listOf("distance", "distance_delta")) { t -> t.contains("distance") } }

        val daily = HuaweiDaily(
            ts = System.currentTimeMillis(),
            steps = activity
                ?.let { sumAny(it, listOf("steps", "steps_delta")) { t -> t.contains("steps") } }
                ?.roundToLong(),
            distanceKm = distanceMetres?.let { (it / 1000.0).round(2) },
            activeKcal = activity
                ?.let { sumAny(it, listOf("calories_total", "calories")) { t -> t.contains("calories") } }
                ?.round(1),
            // Huawei's `calories.burnt` is explicitly *active* calories; there is no
            // total-energy aggregate on this endpoint, so totalKcal stays Health
            // Connect's business.
            totalKcal = null,
            sleepMin = sleep?.minutes,
            sleepStartMs = sleep?.startMs,
            sleepEndMs = sleep?.endMs,
            restingBpm = restingHr
                ?.let { pick(it, listOf("last", "avg", "min", "bpm")) { t -> t.contains("resting") } }
                ?.roundToInt(),
            minBpm = hr?.let { minAny(it, listOf("min", "bpm"), ::isPlainHeartRate) }?.roundToInt(),
            avgBpm = hr?.let { pick(it, listOf("avg", "bpm"), ::isPlainHeartRate) }?.roundToInt(),
            maxBpm = hr?.let { maxAny(it, listOf("max", "bpm"), ::isPlainHeartRate) }?.roundToInt(),
            spo2Pct = spo2
                ?.let {
                    pick(it, listOf("saturation_last", "saturation_avg", "saturation")) { t ->
                        t.contains("spo2")
                    }
                }
                ?.round(1)
        )

        Log.d(TAG, "cloud daily: $daily")
        return daily
    }

    /** The resting-HR statistics type also contains "heart_rate"; exclude it explicitly. */
    private fun isPlainHeartRate(type: String): Boolean =
        type.contains("heart_rate") && !type.contains("resting")

    // ==================================================================
    // Transport
    // ==================================================================

    /** One `sampleSet:dailyPolymerize` call; null on any non-2xx / unparsable answer. */
    private suspend fun dailyStats(
        context: Context,
        dataTypes: List<String>,
        day: String,
        timeZone: String
    ): List<TypedPoint>? = try {
        val body = JSONObject().apply {
            put("dataTypes", JSONArray(dataTypes))
            put("startDay", day)
            put("endDay", day)
            put("timeZone", timeZone)
        }
        val result = HuaweiCloud.apiPost(context, DAILY_URL, body)
        if (!result.ok || result.body == null) {
            Log.d(TAG, "dailyPolymerize$dataTypes failed: HTTP ${result.status}")
            null
        } else {
            parseSamplePoints(JSONObject(result.body)).also {
                Log.d(TAG, "dailyPolymerize$dataTypes -> ${it.size} point(s): $it")
            }
        }
    } catch (e: Exception) {
        Log.d(TAG, "dailyPolymerize$dataTypes unavailable: ${e.message}")
        null
    }

    data class Sleep(val minutes: Long, val startMs: Long?, val endMs: Long?)

    /**
     * Sleep is not a sampling type — Huawei exposes it as a *health record*, and only
     * through the health-records endpoint (see the Sleep Records doc page). Records
     * are read from a 48 h window and kept when they overlap the last 24 h, so a
     * session that started last night still counts in full.
     */
    private suspend fun readSleep(context: Context, now: Instant): Sleep? = try {
        val windowStart = now.minus(Duration.ofHours(SLEEP_WINDOW_HOURS))
        val readFrom = now.minus(Duration.ofHours(SLEEP_LOOKBACK_HOURS))
        // Query params are documented in NANOSECONDS on this endpoint.
        val url = "$RECORDS_URL?startTime=${toNanos(readFrom)}&endTime=${toNanos(now)}" +
            "&dataType=$DT_SLEEP_RECORD"

        val result = HuaweiCloud.apiGet(context, url)
        if (!result.ok || result.body == null) {
            Log.d(TAG, "sleep records failed: HTTP ${result.status}")
            null
        } else {
            parseSleep(JSONObject(result.body), windowStart.toEpochMilli())
                .also { Log.d(TAG, "sleep records -> $it") }
        }
    } catch (e: Exception) {
        Log.d(TAG, "sleep records unavailable: ${e.message}")
        null
    }

    // ==================================================================
    // Pure parsers (no Android, no I/O — the part worth reasoning about)
    // ==================================================================

    /** A sample point flattened to `(dataTypeName, fieldName -> numeric value)`. */
    data class TypedPoint(val dataType: String, val fields: Map<String, Double>)

    /**
     * Walks `group[] -> sampleSet[] -> samplePoints[] -> value[]` and flattens it.
     * Missing levels are tolerated: any of them may legitimately be absent or empty
     * on a day with no data, and a defensive walk beats a schema assertion here.
     */
    fun parseSamplePoints(root: JSONObject): List<TypedPoint> {
        val out = ArrayList<TypedPoint>()
        val groups = root.optJSONArray("group") ?: return out
        for (g in 0 until groups.length()) {
            val sampleSets = groups.optJSONObject(g)?.optJSONArray("sampleSet") ?: continue
            for (s in 0 until sampleSets.length()) {
                val points = sampleSets.optJSONObject(s)?.optJSONArray("samplePoints") ?: continue
                for (p in 0 until points.length()) {
                    val point = points.optJSONObject(p) ?: continue
                    val type = point.optString("dataTypeName").orEmpty()
                    val fields = parseValues(point.optJSONArray("value"))
                    if (fields.isNotEmpty()) out += TypedPoint(type, fields)
                }
            }
        }
        return out
    }

    /**
     * `value: [{fieldName, integerValue|floatValue|longValue|stringValue|mapValue}]`.
     * Only one numeric variant is ever populated per entry; map/string values are of
     * no use to a daily roll-up and are dropped.
     */
    fun parseValues(values: JSONArray?): Map<String, Double> {
        if (values == null) return emptyMap()
        val out = LinkedHashMap<String, Double>()
        for (i in 0 until values.length()) {
            val entry = values.optJSONObject(i) ?: continue
            val name = entry.optString("fieldName").orEmpty()
            if (name.isEmpty()) continue
            val number = when {
                entry.has("floatValue") && !entry.isNull("floatValue") -> entry.optDouble("floatValue")
                entry.has("integerValue") && !entry.isNull("integerValue") ->
                    entry.optDouble("integerValue")
                entry.has("longValue") && !entry.isNull("longValue") -> entry.optDouble("longValue")
                else -> null
            }
            if (number != null && !number.isNaN()) out[name] = number
        }
        return out
    }

    /**
     * Total sleep minutes across every record that overlaps [windowStartMs], plus the
     * newest record's fall-asleep / wake-up stamps (used by the Health Connect
     * write-back, which needs a real interval).
     *
     * Record times are nanoseconds; `fall_asleep_time` / `wakeup_time` fields are
     * milliseconds — the doc is explicit about both, and they disagree on purpose.
     */
    fun parseSleep(root: JSONObject, windowStartMs: Long): Sleep? {
        val records = root.optJSONArray("healthRecords") ?: return null
        var minutes = 0L
        var newestEnd = Long.MIN_VALUE
        var startMs: Long? = null
        var endMs: Long? = null
        var counted = 0

        for (i in 0 until records.length()) {
            val record = records.optJSONObject(i) ?: continue
            val endNs = record.optLong("endTime", 0L)
            val recordEndMs = if (endNs > 0L) endNs / 1_000_000L else 0L
            if (recordEndMs in 1 until windowStartMs) continue

            val fields = parseValues(record.optJSONArray("value"))
            val allSleep = fields["all_sleep_time"]?.roundToLong() ?: continue
            if (allSleep <= 0L) continue

            minutes += allSleep
            counted++

            val fallAsleep = fields["fall_asleep_time"]?.roundToLong()
            val wakeUp = fields["wakeup_time"]?.roundToLong()
            if (recordEndMs >= newestEnd) {
                newestEnd = recordEndMs
                startMs = fallAsleep ?: (if (record.optLong("startTime", 0L) > 0L)
                    record.optLong("startTime") / 1_000_000L else null)
                endMs = wakeUp ?: (if (recordEndMs > 0L) recordEndMs else null)
            }
        }

        if (counted == 0) return null
        // A session with a start but no end (or an inverted pair) is unusable as an
        // interval; drop the stamps rather than write a bogus Health Connect record.
        val validPair = startMs != null && endMs != null && endMs!! > startMs!!
        return Sleep(minutes, if (validPair) startMs else null, if (validPair) endMs else null)
    }

    // --- value pickers -------------------------------------------------

    /**
     * Total of the first field in [preference] that any matching point carries.
     * Summing across points matters: nothing guarantees a single-day query comes back
     * as exactly one group, and two half-days must not silently become one.
     */
    private fun sumAny(
        points: List<TypedPoint>,
        preference: List<String>,
        typeMatches: (String) -> Boolean
    ): Double? {
        val matching = points.filter { typeMatches(it.dataType) }
        for (field in preference) {
            val values = matching.mapNotNull { it.fields[field] }
            if (values.isNotEmpty()) return values.sum()
        }
        return null
    }

    private fun minAny(
        points: List<TypedPoint>,
        preference: List<String>,
        typeMatches: (String) -> Boolean
    ): Double? = valuesOf(points, preference, typeMatches).minOrNull()

    private fun maxAny(
        points: List<TypedPoint>,
        preference: List<String>,
        typeMatches: (String) -> Boolean
    ): Double? = valuesOf(points, preference, typeMatches).maxOrNull()

    /** Last value of the first field in [preference] that any matching point carries. */
    private fun pick(
        points: List<TypedPoint>,
        preference: List<String>,
        typeMatches: (String) -> Boolean
    ): Double? {
        val matching = points.filter { typeMatches(it.dataType) }
        for (field in preference) {
            matching.lastOrNull { it.fields.containsKey(field) }?.let { return it.fields[field] }
        }
        return null
    }

    private fun valuesOf(
        points: List<TypedPoint>,
        preference: List<String>,
        typeMatches: (String) -> Boolean
    ): List<Double> {
        val matching = points.filter { typeMatches(it.dataType) }
        for (field in preference) {
            val values = matching.mapNotNull { it.fields[field] }
            if (values.isNotEmpty()) return values
        }
        return emptyList()
    }

    // --- misc ----------------------------------------------------------

    /**
     * Huawei wants `+0800`, java.time hands out `+08:00` (and a bare `Z` for UTC).
     */
    fun zoneOffsetString(zone: ZoneId, at: Instant): String {
        val id = zone.rules.getOffset(at).id
        return if (id == "Z") "+0000" else id.replace(":", "")
    }

    private fun toNanos(instant: Instant): Long = instant.toEpochMilli() * 1_000_000L

    private fun Double.round(decimals: Int): Double {
        var factor = 1.0
        repeat(decimals) { factor *= 10 }
        return (this * factor).roundToLong() / factor
    }
}
