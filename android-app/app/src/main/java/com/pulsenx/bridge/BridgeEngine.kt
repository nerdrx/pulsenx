package com.pulsenx.bridge

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.os.Handler
import android.os.Looper

/**
 * Process-wide, UI-agnostic state shared between [VitalsBridgeService] and [MainActivity].
 * The service is the only writer; the activity subscribes with the listener slots.
 */
@SuppressLint("StaticFieldLeak")
object BridgeEngine {

    /** Live handle on the running foreground service (null while it is not running). */
    var serviceInstance: VitalsBridgeService? = null

    private val main = Handler(Looper.getMainLooper())

    var isScanning = false
        set(value) {
            field = value
            notifyUiStatusChanged()
        }

    /** True while the PC transport (LAN WS or cloud MQTT) is up. */
    var pcConnected = false
        set(value) {
            field = value
            notifyUiStatusChanged()
        }

    /** True once the HR characteristic notifications are enabled on the watch. */
    var watchConnected = false
        set(value) {
            field = value
            notifyUiStatusChanged()
        }

    /** "LAN 192.168.x.y" / "CLOUD ABC123" / "" — shown under the PC status line. */
    var pcDetail: String = ""
        set(value) {
            field = value
            notifyUiStatusChanged()
        }

    var watchName: String = ""
        set(value) {
            field = value
            notifyUiStatusChanged()
        }

    /** "ble" (watch GATT) or "health" (Health Connect poller) — mirrors the HR_SOURCE pref. */
    var hrSource: String = VitalsBridgeService.SOURCE_BLE
        set(value) {
            field = value
            notifyUiStatusChanged()
        }

    /** Null while the Health Connect source is healthy, otherwise why it is not producing. */
    var healthSourceError: String? = null
        set(value) {
            field = value
            notifyUiStatusChanged()
            notifyHealthChanged()
        }

    /** Epoch ms of the newest sample the Health Connect source forwarded. */
    var lastHealthSampleAt = 0L

    var lastBpm = 0
    var lastRssi = 0

    /** Latest daily roll-up read from Health Connect, or null before the first read. */
    var lastHealthSummary: HealthSummary? = null
        set(value) {
            field = value
            notifyHealthChanged()
        }

    val discoveredDevices = ArrayList<BluetoothDevice>()

    var uiBpmListener: ((Int) -> Unit)? = null
    var uiStatusListener: (() -> Unit)? = null
    var uiHealthListener: (() -> Unit)? = null

    fun addDiscoveredDevice(device: BluetoothDevice) {
        if (discoveredDevices.none { it.address == device.address }) {
            discoveredDevices.add(device)
        }
    }

    fun notifyBpmUpdated(bpm: Int) {
        lastBpm = bpm
        main.post { uiBpmListener?.invoke(bpm) }
    }

    fun notifyUiStatusChanged() {
        main.post { uiStatusListener?.invoke() }
    }

    fun notifyHealthChanged() {
        main.post { uiHealthListener?.invoke() }
    }

    fun resetVitals() {
        lastBpm = 0
        lastRssi = 0
        lastHealthSampleAt = 0L
        main.post { uiBpmListener?.invoke(0) }
    }
}
