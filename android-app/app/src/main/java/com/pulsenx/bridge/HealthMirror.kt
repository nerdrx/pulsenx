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
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Duration
import java.time.Instant
import kotlin.reflect.KClass

/**
 * The Huawei → PulseNX-origin mirror engine ("Google Fit sync"), shared by two drivers:
 *
 *   - [VitalsBridgeService]'s 5-minute tick, the fast path while the bridge is alive
 *     (a foreground service may repeat work as often as it likes);
 *   - [HealthSyncWorker], WorkManager's 15-minute periodic job — the floor Android
 *     allows for periodic work — as the backstop for when the service is dead.
 *
 * A [Mutex] serialises the two drivers: the changes-token cursor is shared state, and
 * two overlapping passes would race its read-advance-write cycle. (The upsert
 * `clientRecordId`s would keep the *data* correct regardless; the lock is about not
 * burning a pass re-mirroring what the other driver just wrote.)
 *
 * Idempotency and loop safety are documented on [HealthSyncWorker]; the strategy code
 * here is unchanged from the original worker implementation.
 */
object HealthMirror {

    private const val TAG = "PulseNX/HealthMirror"

    private const val BACKFILL_DAYS = 7L
    private const val INSERT_CHUNK = 200

    private val lock = Mutex()

    /**
     * Runs one mirror pass if the feature is enabled and permitted; returns the number
     * of records written (0 for a disabled/unavailable/quiet pass). Never throws for
     * the routine failure modes — only an unexpected mid-pass error propagates, so the
     * WorkManager driver can translate it into a retry.
     */
    suspend fun sync(context: Context): Int {
        val prefs = context.getSharedPreferences(VitalsBridgeService.PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(VitalsBridgeService.KEY_FIT_MIRROR, false)) return 0

        val client = HealthConnectHub.client(context) ?: return 0

        val granted = HealthConnectHub.grantedPermissions(context)
        if (!granted.containsAll(HealthConnectHub.READ_PERMISSIONS) ||
            !granted.containsAll(HealthConnectHub.WRITE_PERMISSIONS)
        ) {
            Log.d(TAG, "mirror permissions incomplete, skipping this pass")
            return 0
        }

        return lock.withLock {
            val written = when (val token = prefs.getString(VitalsBridgeService.KEY_MIRROR_TOKEN, null)) {
                null -> backfill(context, client)
                else -> incremental(context, client, token)
            }
            if (written > 0) Log.d(TAG, "mirror pass wrote $written record(s)")
            written
        }
    }

    // ==================================================================
    // Strategies
    // ==================================================================

    /**
     * First enable: take the changes token FIRST (so anything written while we backfill
     * still shows up on the next pass), then copy the last 7 days.
     */
    private suspend fun backfill(context: Context, client: HealthConnectClient): Int {
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

        prefsOf(context).edit().putString(VitalsBridgeService.KEY_MIRROR_TOKEN, token).apply()
        Log.d(TAG, "backfill mirrored $written record(s)")
        return written
    }

    private suspend fun incremental(context: Context, client: HealthConnectClient, startToken: String): Int {
        var token = startToken
        var written = 0

        while (true) {
            val response = client.getChanges(token)
            if (response.changesTokenExpired) {
                // The provider garbage-collected our cursor; start over from a backfill.
                Log.d(TAG, "changes token expired, falling back to backfill")
                prefsOf(context).edit().remove(VitalsBridgeService.KEY_MIRROR_TOKEN).apply()
                return written + backfill(context, client)
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

        prefsOf(context).edit().putString(VitalsBridgeService.KEY_MIRROR_TOKEN, token).apply()
        return written
    }

    private fun prefsOf(context: Context) =
        context.getSharedPreferences(VitalsBridgeService.PREFS, Context.MODE_PRIVATE)

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
        val clientRecordId = "mirror-$tag-${source.id}"
        val clientRecordVersion = source.lastModifiedTime.toEpochMilli().coerceAtLeast(1L)
        val device = source.device ?: Device(type = Device.TYPE_UNKNOWN)

        // The stable client's Metadata factories replace the old public constructor;
        // dispatch on the source's recording method so the mirror copy keeps it.
        return when (source.recordingMethod) {
            Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED -> Metadata.autoRecorded(
                device = device,
                clientRecordId = clientRecordId,
                clientRecordVersion = clientRecordVersion
            )

            Metadata.RECORDING_METHOD_ACTIVELY_RECORDED -> Metadata.activelyRecorded(
                device = device,
                clientRecordId = clientRecordId,
                clientRecordVersion = clientRecordVersion
            )

            Metadata.RECORDING_METHOD_MANUAL_ENTRY -> Metadata.manualEntry(
                clientRecordId = clientRecordId,
                clientRecordVersion = clientRecordVersion,
                device = source.device
            )

            else -> Metadata.unknownRecordingMethod(
                clientRecordId = clientRecordId,
                clientRecordVersion = clientRecordVersion,
                device = source.device
            )
        }
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
