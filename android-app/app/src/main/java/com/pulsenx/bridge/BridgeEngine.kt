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

    var lastBpm = 0
    var lastRssi = 0

    val discoveredDevices = ArrayList<BluetoothDevice>()

    var uiBpmListener: ((Int) -> Unit)? = null
    var uiStatusListener: (() -> Unit)? = null

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

    fun resetVitals() {
        lastBpm = 0
        lastRssi = 0
        main.post { uiBpmListener?.invoke(0) }
    }
}
