package com.pulsenx.bridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import java.time.Instant
import java.time.ZoneId
import kotlin.reflect.KClass

/**
 * One place for everything Health Connect: SDK availability, the permission sets,
 * the client handle and the heart-rate writer.
 *
 * Why Health Connect at all, and not Google Fit? Google's Fit REST/Android APIs are
 * closed to new third-party integrations, so a "sync to Fit" feature can no longer be
 * built directly. Health Connect is the sanctioned on-device exchange layer that Fit
 * and every other reader now consume, which makes it the only durable target.
 */
object HealthConnectHub {

    private const val TAG = "PulseNX/HealthHub"

    /**
     * The Health Connect provider app. Only meaningful below Android 14: from 14 on,
     * Health Connect is a platform module and no such APK exists. Kept for the
     * pre-14 Play Store install flow and the manifest `<queries>` entry — never pass
     * it to [HealthConnectClient.getSdkStatus] / [HealthConnectClient.getOrCreate].
     */
    const val PROVIDER_PACKAGE = "com.google.android.apps.healthdata"

    /** Huawei Health writes into Health Connect under this package name. */
    const val HUAWEI_PACKAGE = "com.huawei.health"

    /** Our own origin — mirrored records must never be re-mirrored (that would loop). */
    const val SELF_PACKAGE = "com.pulsenx.bridge"

    // The `HealthPermission.READ_*` string constants are Kotlin-internal in this release;
    // the per-record-type helpers are the supported way to name the same permissions.
    val READ_HEART_RATE: String = HealthPermission.getReadPermission(HeartRateRecord::class)
    val WRITE_HEART_RATE: String = HealthPermission.getWritePermission(HeartRateRecord::class)

    /** Everything the daily summary + the mirror sync need to read. */
    val READ_PERMISSIONS: Set<String> = setOf(
        READ_HEART_RATE,
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(OxygenSaturationRecord::class),
        HealthPermission.getReadPermission(ExerciseSessionRecord::class)
    )

    /** Everything the HC writer + the mirror sync need to write. */
    val WRITE_PERMISSIONS: Set<String> = setOf(
        WRITE_HEART_RATE,
        HealthPermission.getWritePermission(StepsRecord::class),
        HealthPermission.getWritePermission(DistanceRecord::class),
        HealthPermission.getWritePermission(ActiveCaloriesBurnedRecord::class),
        HealthPermission.getWritePermission(TotalCaloriesBurnedRecord::class),
        HealthPermission.getWritePermission(SleepSessionRecord::class),
        HealthPermission.getWritePermission(ExerciseSessionRecord::class)
    )

    val ALL_PERMISSIONS: Set<String> = READ_PERMISSIONS + WRITE_PERMISSIONS

    /** Record types the mirror sync copies out of Huawei Health. */
    val MIRRORED_TYPES: Set<KClass<out Record>> = setOf(
        HeartRateRecord::class,
        StepsRecord::class,
        DistanceRecord::class,
        ActiveCaloriesBurnedRecord::class,
        TotalCaloriesBurnedRecord::class,
        SleepSessionRecord::class,
        ExerciseSessionRecord::class
    )

    // ==================================================================
    // Availability
    // ==================================================================

    /**
     * One of [HealthConnectClient.SDK_AVAILABLE] / `SDK_UNAVAILABLE*`.
     *
     * Deliberately uses the *no-provider-package* overload. Passing [PROVIDER_PACKAGE]
     * explicitly forces the client down the "look for the healthdata APK" path, and on
     * Android 14+ that APK does not exist — Health Connect is a platform module there —
     * so an explicit package makes every 14/15/16 phone report `SDK_UNAVAILABLE` and the
     * app claim Health Connect "isn't installed" while it sits in system Settings.
     * The default overload picks the platform on API 34+ and the APK below it.
     */
    fun sdkStatus(context: Context): Int = try {
        HealthConnectClient.getSdkStatus(context)
    } catch (e: Exception) {
        Log.w(TAG, "getSdkStatus failed: ${e.message}")
        HealthConnectClient.SDK_UNAVAILABLE
    }

    fun isAvailable(context: Context): Boolean =
        sdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    /** Null whenever the provider is missing / too old / refuses to bind. */
    fun client(context: Context): HealthConnectClient? {
        if (!isAvailable(context)) return null
        return try {
            // Same reasoning as sdkStatus: the default overload is the platform-aware one.
            HealthConnectClient.getOrCreate(context)
        } catch (e: Exception) {
            Log.w(TAG, "getOrCreate failed: ${e.message}")
            null
        }
    }

    suspend fun grantedPermissions(context: Context): Set<String> = try {
        client(context)?.permissionController?.getGrantedPermissions() ?: emptySet()
    } catch (e: Exception) {
        Log.w(TAG, "getGrantedPermissions failed: ${e.message}")
        emptySet()
    }

    suspend fun hasPermissions(context: Context, wanted: Set<String>): Boolean =
        grantedPermissions(context).containsAll(wanted)

    /**
     * True when Health Connect lives in the platform rather than in a Play Store app.
     * On such devices there is nothing to install, so the UI must send users to
     * Settings instead of to a Play listing that does not exist.
     */
    val isPlatformProvider: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

    /** Health Connect's own settings screen (platform module on 14+, provider app below). */
    fun settingsIntent(): Intent =
        Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)

    /** Play Store deep link for installing / updating the provider app. */
    fun installIntent(): Intent =
        Intent(Intent.ACTION_VIEW).apply {
            setPackage("com.android.vending")
            data = Uri.parse(
                "market://details?id=$PROVIDER_PACKAGE&url=healthconnect%3A%2F%2Fonboarding"
            )
            putExtra("overlay", true)
            putExtra("callerId", SELF_PACKAGE)
        }

    // ==================================================================
    // Writing BLE-captured heart rate back into Health Connect
    // ==================================================================

    /**
     * Persists a batch of `(epochMs, bpm)` samples as ONE [HeartRateRecord] series.
     *
     * The clientRecordId is derived from the first sample's timestamp, so replaying the
     * same batch after a crash updates the existing record instead of duplicating it.
     */
    suspend fun writeHeartRateSeries(context: Context, samples: List<Pair<Long, Int>>): Boolean {
        if (samples.isEmpty()) return false
        val client = client(context) ?: return false

        return try {
            if (!grantedPermissions(context).contains(WRITE_HEART_RATE)) {
                Log.d(TAG, "WRITE_HEART_RATE not granted, dropping ${samples.size} samples")
                return false
            }

            val ordered = samples.sortedBy { it.first }
            val start = Instant.ofEpochMilli(ordered.first().first)
            // Health Connect rejects zero-length interval records.
            val rawEnd = Instant.ofEpochMilli(ordered.last().first)
            val end = if (rawEnd.isAfter(start)) rawEnd else start.plusMillis(1)

            val zone = ZoneId.systemDefault().rules
            val record = HeartRateRecord(
                startTime = start,
                startZoneOffset = zone.getOffset(start),
                endTime = end,
                endZoneOffset = zone.getOffset(end),
                samples = ordered.map {
                    HeartRateRecord.Sample(
                        time = Instant.ofEpochMilli(it.first),
                        beatsPerMinute = it.second.toLong()
                    )
                },
                // The public Metadata(...) constructor is `internal` as of connect-client
                // 1.1.0; the recording method now picks the factory. Same clientRecordId
                // and clientRecordVersion as before, so upserts still dedup against the
                // records already on users' phones.
                //
                // `autoRecorded` demands a non-null Device where the old constructor let
                // it default to null. TYPE_UNKNOWN is the faithful translation: it claims
                // nothing about the BLE peer, exactly as the absent device did.
                metadata = Metadata.autoRecorded(
                    device = Device(type = Device.TYPE_UNKNOWN),
                    clientRecordId = "pulsenx-hr-${ordered.first().first}",
                    clientRecordVersion = 1L
                )
            )

            client.insertRecords(listOf(record))
            Log.d(TAG, "wrote ${ordered.size} HR samples to Health Connect")
            true
        } catch (e: Exception) {
            Log.w(TAG, "HR write failed: ${e.message}")
            false
        }
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    /** "24 s" / "3 min" / "2 h" — used in the notification and the health card. */
    fun ago(millis: Long): String {
        val seconds = (millis / 1000).coerceAtLeast(0)
        return when {
            seconds < 90 -> "$seconds s"
            seconds < 5400 -> "${seconds / 60} min"
            else -> "${seconds / 3600} h"
        }
    }
}
