package com.pulsenx.bridge

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.reflect.KClass

/**
 * "Google Fit mirror sync".
 *
 * Rationale: Google Fit's third-party APIs (REST + the Android Fitness SDK) are closed
 * to new integrations, so PulseNX cannot push to Fit directly. Health Connect is the
 * sanctioned exchange layer that Fit and every other health reader now consume — but
 * records stay bound to the origin that wrote them, and Huawei Health's origin is not
 * one downstream readers can connect to. Re-writing Huawei-origin records under the
 * PulseNX origin therefore guarantees the same data surfaces to any Health Connect
 * reader through an origin the user *can* connect.
 *
 * Idempotency: every mirrored record carries `clientRecordId = "mirror-<type>-<id>"`
 * and a `clientRecordVersion` taken from the source's lastModifiedTime, so re-running
 * the worker upserts instead of duplicating.
 *
 * Loop safety: records whose dataOrigin is already `com.pulsenx.bridge` are skipped
 * unconditionally — mirroring our own mirrors would grow without bound.
 */
class HealthSyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "PulseNX/HealthSync"

        const val WORK_NAME = "pulsenx-health-mirror"
        private const val INTERVAL_MINUTES = 15L
        private const val BACKFILL_DAYS = 7L
        private const val INSERT_CHUNK = 200

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

    private val prefs by lazy {
        applicationContext.getSharedPreferences(VitalsBridgeService.PREFS, Context.MODE_PRIVATE)
    }

    override suspend fun doWork(): Result {
        if (!prefs.getBoolean(VitalsBridgeService.KEY_FIT_MIRROR, false)) {
            Log.d(TAG, "mirror disabled, nothing to do")
            return Result.success()
        }

        val client = HealthConnectHub.client(applicationContext)
        if (client == null) {
            Log.d(TAG, "Health Connect unavailable, skipping this run")
            return Result.success()
        }

        return try {
            val granted = HealthConnectHub.grantedPermissions(applicationContext)
            if (!granted.containsAll(HealthConnectHub.READ_PERMISSIONS) ||
                !granted.containsAll(HealthConnectHub.WRITE_PERMISSIONS)
            ) {
                Log.d(TAG, "mirror permissions incomplete, skipping this run")
                return Result.success()
            }

            val mirrored = when (val token = prefs.getString(VitalsBridgeService.KEY_MIRROR_TOKEN, null)) {
                null -> backfill(client)
                else -> incremental(client, token)
            }
            Log.d(TAG, "mirror run complete, $mirrored record(s) written")
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "mirror run failed", e)
            Result.retry()
        }
    }

    // ==================================================================
    // Strategies
    // ==================================================================

    /**
     * First enable: take the changes token FIRST (so anything written while we backfill
     * still shows up on the next run), then copy the last 7 days.
     */
    private suspend fun backfill(client: HealthConnectClient): Int {
        val token = client.getChangesToken(
            ChangesTokenRequest(
                recordTypes = HealthConnectHub.MIRRORED_TYPES,
                dataOriginFilters = setOf(DataOrigin(HealthConnectHub.HUAWEI_PACKAGE))
            )
        )

        val since = Instant.now().minus(Duration.ofDays(BACKFILL_DAYS))
        val range = TimeRangeFilter.between(since, Instant.now())
        var written = 0

        for (type in HealthConnectHub.MIRRORED_TYPES) {
            written += mirror(client, readAllOfType(client, type, range))
        }

        prefs.edit().putString(VitalsBridgeService.KEY_MIRROR_TOKEN, token).apply()
        Log.d(TAG, "backfill mirrored $written record(s)")
        return written
    }

    private suspend fun incremental(client: HealthConnectClient, startToken: String): Int {
        var token = startToken
        var written = 0

        while (true) {
            val response = client.getChanges(token)
            if (response.changesTokenExpired) {
                // The provider garbage-collected our cursor; start over from a backfill.
                Log.d(TAG, "changes token expired, falling back to backfill")
                prefs.edit().remove(VitalsBridgeService.KEY_MIRROR_TOKEN).apply()
                return written + backfill(client)
            }

            // Deletions carry only the provider's own record id, which we never store,
            // so a deleted source record leaves its mirror behind. Acceptable: the
            // mirror is an additive export, not a two-way sync.
            written += mirror(
                client,
                response.changes.filterIsInstance<UpsertionChange>().map { it.record }
            )

            token = response.nextChangesToken
            if (!response.hasMore) break
        }

        prefs.edit().putString(VitalsBridgeService.KEY_MIRROR_TOKEN, token).apply()
        return written
    }

    private suspend fun <T : Record> readAllOfType(
        client: HealthConnectClient,
        type: KClass<T>,
        range: TimeRangeFilter
    ): List<T> {
        val all = ArrayList<T>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = type,
                    timeRangeFilter = range,
                    dataOriginFilter = setOf(DataOrigin(HealthConnectHub.HUAWEI_PACKAGE)),
                    ascendingOrder = true,
                    pageToken = pageToken
                )
            )
            all += response.records
            pageToken = response.pageToken
        } while (pageToken != null)
        return all
    }

    // ==================================================================
    // Mirroring
    // ==================================================================

    private suspend fun mirror(client: HealthConnectClient, source: List<Record>): Int {
        val clones = source
            .filter { it.metadata.dataOrigin.packageName == HealthConnectHub.HUAWEI_PACKAGE }
            .filter { it.metadata.dataOrigin.packageName != HealthConnectHub.SELF_PACKAGE }
            .mapNotNull { clone(it) }

        if (clones.isEmpty()) return 0

        var written = 0
        for (chunk in clones.chunked(INSERT_CHUNK)) {
            try {
                client.insertRecords(chunk)
                written += chunk.size
            } catch (e: Exception) {
                Log.w(TAG, "mirror insert of ${chunk.size} record(s) failed: ${e.message}")
            }
        }
        return written
    }

    /** `clientRecordId` keys the upsert; a missing source id makes the record unmirrorable. */
    private fun mirrorMetadata(tag: String, source: Metadata): Metadata? {
        if (source.id.isEmpty()) return null
        return Metadata(
            clientRecordId = "mirror-$tag-${source.id}",
            clientRecordVersion = source.lastModifiedTime.toEpochMilli().coerceAtLeast(1L),
            device = source.device,
            recordingMethod = source.recordingMethod
        )
    }

    private fun clone(record: Record): Record? = try {
        when (record) {
            is HeartRateRecord -> mirrorMetadata("HeartRate", record.metadata)?.let {
                HeartRateRecord(
                    startTime = record.startTime,
                    startZoneOffset = record.startZoneOffset,
                    endTime = record.endTime,
                    endZoneOffset = record.endZoneOffset,
                    samples = record.samples,
                    metadata = it
                )
            }

            is StepsRecord -> mirrorMetadata("Steps", record.metadata)?.let {
                StepsRecord(
                    startTime = record.startTime,
                    startZoneOffset = record.startZoneOffset,
                    endTime = record.endTime,
                    endZoneOffset = record.endZoneOffset,
                    count = record.count,
                    metadata = it
                )
            }

            is DistanceRecord -> mirrorMetadata("Distance", record.metadata)?.let {
                DistanceRecord(
                    startTime = record.startTime,
                    startZoneOffset = record.startZoneOffset,
                    endTime = record.endTime,
                    endZoneOffset = record.endZoneOffset,
                    distance = record.distance,
                    metadata = it
                )
            }

            is ActiveCaloriesBurnedRecord -> mirrorMetadata("ActiveCalories", record.metadata)?.let {
                ActiveCaloriesBurnedRecord(
                    startTime = record.startTime,
                    startZoneOffset = record.startZoneOffset,
                    endTime = record.endTime,
                    endZoneOffset = record.endZoneOffset,
                    energy = record.energy,
                    metadata = it
                )
            }

            is TotalCaloriesBurnedRecord -> mirrorMetadata("TotalCalories", record.metadata)?.let {
                TotalCaloriesBurnedRecord(
                    startTime = record.startTime,
                    startZoneOffset = record.startZoneOffset,
                    endTime = record.endTime,
                    endZoneOffset = record.endZoneOffset,
                    energy = record.energy,
                    metadata = it
                )
            }

            is SleepSessionRecord -> mirrorMetadata("Sleep", record.metadata)?.let {
                SleepSessionRecord(
                    startTime = record.startTime,
                    startZoneOffset = record.startZoneOffset,
                    endTime = record.endTime,
                    endZoneOffset = record.endZoneOffset,
                    title = record.title,
                    notes = record.notes,
                    stages = record.stages,
                    metadata = it
                )
            }

            // Exercise routes need WRITE_EXERCISE_ROUTE and a separate consent flow,
            // so the mirror carries the session without its GPS trace.
            is ExerciseSessionRecord -> mirrorMetadata("Exercise", record.metadata)?.let {
                ExerciseSessionRecord(
                    startTime = record.startTime,
                    startZoneOffset = record.startZoneOffset,
                    endTime = record.endTime,
                    endZoneOffset = record.endZoneOffset,
                    exerciseType = record.exerciseType,
                    title = record.title,
                    notes = record.notes,
                    metadata = it,
                    segments = record.segments,
                    laps = record.laps,
                    exerciseRoute = null
                )
            }

            else -> null
        }
    } catch (e: Exception) {
        Log.w(TAG, "clone failed: ${e.message}")
        null
    }
}
