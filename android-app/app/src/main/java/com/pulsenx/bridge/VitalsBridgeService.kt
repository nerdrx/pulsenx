package com.pulsenx.bridge

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.util.UUID
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * The whole bridge: BLE heart-rate client on one side, PC transport on the other,
 * kept alive by a `connectedDevice` foreground service.
 */
class VitalsBridgeService : Service(), PcLink.Listener {

    companion object {
        private const val TAG = "PulseNX/Service"
        private const val CHANNEL_ID = "pulsenx_bridge"
        private const val NOTIFICATION_ID = 1001

        const val PREFS = "PulseNXPrefs"
        const val KEY_PAIRED_MAC = "PAIRED_MAC"
        const val KEY_PAIRED_NAME = "PAIRED_NAME"
        const val KEY_PC_TARGET = "PC_TARGET"

        const val ACTION_LINK_PC = "com.pulsenx.bridge.LINK_PC"
        const val ACTION_DISCONNECT_PC = "com.pulsenx.bridge.DISCONNECT_PC"
        const val ACTION_START_SCAN = "com.pulsenx.bridge.START_SCAN"
        const val ACTION_STOP_SCAN = "com.pulsenx.bridge.STOP_SCAN"
        const val ACTION_UNPAIR_WATCH = "com.pulsenx.bridge.UNPAIR_WATCH"
        const val ACTION_CONNECT_DEVICE = "com.pulsenx.bridge.CONNECT_DEVICE"

        const val EXTRA_PC_TARGET = "PC_TARGET"
        const val EXTRA_DEVICE_MAC = "DEVICE_MAC"

        private const val SCAN_TIMEOUT_MS = 15_000L
        private const val BLE_RECONNECT_MS = 3_000L
        private const val RSSI_POLL_MS = 30_000L
        private const val HAPTIC_MIN_GAP_MS = 10_000L
        private const val HIGH_HR_THRESHOLD = 165

        private const val DISCOVERY_PORT = 9001

        private val HEART_RATE_SERVICE_UUID: UUID =
            UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
        private val HEART_RATE_CHAR_UUID: UUID =
            UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")
        private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID =
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private val WATCH_NAME_HINTS = listOf(
            "huawei", "watch", "galaxy", "pixel", "fitbit",
            "garmin", "polar", "band", "heart", "hr"
        )
    }

    private val handler = Handler(Looper.getMainLooper())

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private lateinit var pcLink: PcLink

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var bluetoothGatt: BluetoothGatt? = null
    private var lastConnectedDevice: BluetoothDevice? = null
    private var lastRssi = 0
    private var lastHapticAt = 0L

    private var udpSocket: DatagramSocket? = null
    @Volatile
    private var udpListening = false

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var btReceiverRegistered = false
    private var notificationText = "Starting…"

    // ==================================================================
    // Lifecycle
    // ==================================================================

    override fun onCreate() {
        super.onCreate()
        BridgeEngine.serviceInstance = this
        pcLink = PcLink(applicationContext, this)

        createNotificationChannel()
        pushNotification("Bridge running")

        acquireLocks()
        initBluetooth()
        registerBtReceiver()
        registerNetworkCallback()
        startUdpDiscoveryListener()

        // Resume whatever we were linked to before the process died / the phone rebooted.
        val prefs = prefs()
        prefs.getString(KEY_PC_TARGET, "")?.takeIf { it.isNotEmpty() }?.let { pcLink.connect(it) }
        prefs.getString(KEY_PAIRED_MAC, "")?.takeIf { it.isNotEmpty() }?.let { connectToWatchByMac(it) }
        BridgeEngine.watchName = prefs.getString(KEY_PAIRED_NAME, "") ?: ""
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        pushNotification(notificationText)

        when (intent?.action) {
            ACTION_LINK_PC -> {
                val target = intent.getStringExtra(EXTRA_PC_TARGET).orEmpty()
                if (target.isNotEmpty()) {
                    prefs().edit().putString(KEY_PC_TARGET, target).apply()
                    pcLink.connect(target)
                }
            }

            ACTION_DISCONNECT_PC -> {
                prefs().edit().remove(KEY_PC_TARGET).apply()
                pcLink.disconnect()
            }

            ACTION_START_SCAN -> startBleScan()
            ACTION_STOP_SCAN -> stopBleScan()
            ACTION_UNPAIR_WATCH -> unpairWatch()
            ACTION_CONNECT_DEVICE ->
                intent.getStringExtra(EXTRA_DEVICE_MAC)
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { connectToWatchByMac(it) }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        udpListening = false
        handler.removeCallbacksAndMessages(null)
        try {
            if (btReceiverRegistered) unregisterReceiver(btStateReceiver)
        } catch (_: Exception) {
        }
        networkCallback?.let {
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager)
                    .unregisterNetworkCallback(it)
            } catch (_: Exception) {
            }
        }
        try { udpSocket?.close() } catch (_: Exception) {}
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        try { if (wifiLock?.isHeld == true) wifiLock?.release() } catch (_: Exception) {}
        closeGatt()
        pcLink.shutdown()
        BridgeEngine.serviceInstance = null
    }

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    // ==================================================================
    // Locks / system plumbing
    // ==================================================================

    private fun acquireLocks() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PulseNX::ServiceWakeLock")
            if (wakeLock?.isHeld == false) wakeLock?.acquire()
        } catch (e: Exception) {
            Log.e(TAG, "wake lock failed", e)
        }

        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiLock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "PulseNX::ServiceWifiLock")
            } else {
                wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PulseNX::ServiceWifiLock")
            }
            if (wifiLock?.isHeld == false) wifiLock?.acquire()
        } catch (e: Exception) {
            Log.e(TAG, "wifi lock failed", e)
        }
    }

    private fun initBluetooth() {
        bluetoothAdapter =
            (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    }

    private fun registerBtReceiver() {
        try {
            registerReceiver(btStateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
            btReceiverRegistered = true
        } catch (e: Exception) {
            Log.e(TAG, "bt receiver registration failed", e)
        }
    }

    private val btStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON -> {
                    Log.d(TAG, "Bluetooth on, resuming watch link")
                    val mac = lastConnectedDevice?.address
                        ?: prefs().getString(KEY_PAIRED_MAC, "").orEmpty()
                    if (mac.isNotEmpty()) handler.postDelayed({ connectToWatchByMac(mac) }, 1000)
                }

                BluetoothAdapter.STATE_OFF -> {
                    BridgeEngine.watchConnected = false
                    closeGatt()
                    pushNotification(statusLine())
                }
            }
        }
    }

    private fun registerNetworkCallback() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Log.d(TAG, "network available, re-evaluating PC link")
                    handler.post { pcLink.reconnect() }
                }
            }
            networkCallback = cb
            cm.registerNetworkCallback(request, cb)
        } catch (e: Exception) {
            Log.e(TAG, "network callback registration failed", e)
        }
    }

    /** Listens for the PC's UDP beacon so a LAN link needs no typing at all. */
    private fun startUdpDiscoveryListener() {
        if (udpListening) return
        udpListening = true

        thread(name = "PulseNX-UDP-Discovery") {
            try {
                val socket = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(java.net.InetSocketAddress(DISCOVERY_PORT))
                }
                udpSocket = socket
                val buffer = ByteArray(2048)
                Log.d(TAG, "UDP discovery listening on :$DISCOVERY_PORT")

                while (udpListening) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val message = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    try {
                        val json = JSONObject(message)
                        if (json.optString("service") != "pulsenx") continue
                        val hostIp = packet.address?.hostAddress.orEmpty()
                        if (hostIp.isNotEmpty() && !pcLink.isConnected) {
                            Log.d(TAG, "PC beacon from $hostIp")
                            handler.post {
                                if (!pcLink.isConnected) {
                                    prefs().edit().putString(KEY_PC_TARGET, hostIp).apply()
                                    pcLink.connect(hostIp)
                                }
                            }
                        }
                    } catch (_: Exception) {
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "UDP discovery stopped: ${e.message}")
            }
        }
    }

    // ==================================================================
    // PC link callbacks
    // ==================================================================

    override fun onLinkStateChanged(connected: Boolean, detail: String) {
        BridgeEngine.pcConnected = connected
        BridgeEngine.pcDetail = detail
        pushNotification(statusLine())
    }

    // ==================================================================
    // BLE scan
    // ==================================================================

    private fun hasScanPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }

    private fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    fun startBleScan() {
        if (BridgeEngine.isScanning) return
        val scanner = bluetoothAdapter?.takeIf { it.isEnabled }?.bluetoothLeScanner
        if (scanner == null) {
            pushNotification("Bluetooth is off")
            return
        }
        if (!hasScanPermission()) {
            Log.w(TAG, "scan permission missing")
            return
        }

        BridgeEngine.discoveredDevices.clear()
        BridgeEngine.isScanning = true
        handler.postDelayed(scanTimeout, SCAN_TIMEOUT_MS)

        try {
            scanner.startScan(bleScanCallback)
            pushNotification("Scanning for a watch…")
        } catch (e: SecurityException) {
            BridgeEngine.isScanning = false
            Log.e(TAG, "startScan denied", e)
        }
    }

    private val scanTimeout = Runnable {
        if (BridgeEngine.isScanning) {
            stopBleScan()
            pushNotification(statusLine())
        }
    }

    fun stopBleScan() {
        handler.removeCallbacks(scanTimeout)
        if (!BridgeEngine.isScanning) return
        BridgeEngine.isScanning = false
        try {
            if (hasScanPermission()) {
                bluetoothAdapter?.bluetoothLeScanner?.stopScan(bleScanCallback)
            }
        } catch (_: SecurityException) {
        }
    }

    private val bleScanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            val device = result?.device ?: return
            try {
                val name = if (hasConnectPermission()) device.name else null
                val advertisesHr =
                    result.scanRecord?.serviceUuids?.any { it.uuid == HEART_RATE_SERVICE_UUID } == true

                if (!advertisesHr && (name == null || !matchesWatchName(name))) return

                BridgeEngine.addDiscoveredDevice(device)

                val savedMac = prefs().getString(KEY_PAIRED_MAC, "").orEmpty()
                if (savedMac.isEmpty() || savedMac == device.address) {
                    stopBleScan()
                    connectToWatchByDevice(device)
                }
            } catch (_: SecurityException) {
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e(TAG, "scan failed: $errorCode")
            BridgeEngine.isScanning = false
            handler.removeCallbacks(scanTimeout)
        }
    }

    private fun matchesWatchName(name: String): Boolean {
        val lower = name.lowercase()
        return WATCH_NAME_HINTS.any { lower.contains(it) }
    }

    // ==================================================================
    // GATT
    // ==================================================================

    fun connectToWatchByMac(mac: String) {
        val device = try {
            bluetoothAdapter?.getRemoteDevice(mac)
        } catch (e: IllegalArgumentException) {
            null
        }
        if (device != null) connectToWatchByDevice(device)
    }

    private fun connectToWatchByDevice(device: BluetoothDevice) {
        stopBleScan()
        if (!hasConnectPermission()) {
            Log.w(TAG, "connect permission missing")
            return
        }
        lastConnectedDevice = device

        val name = try {
            device.name.orEmpty()
        } catch (_: SecurityException) {
            ""
        }
        prefs().edit()
            .putString(KEY_PAIRED_MAC, device.address)
            .putString(KEY_PAIRED_NAME, name)
            .apply()
        BridgeEngine.watchName = name.ifEmpty { device.address }

        try {
            closeGatt()
            bluetoothGatt = device.connectGatt(
                applicationContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE
            )
            pushNotification("Connecting to ${BridgeEngine.watchName}…")
        } catch (e: SecurityException) {
            Log.e(TAG, "connectGatt denied", e)
        }
    }

    fun unpairWatch() {
        prefs().edit().remove(KEY_PAIRED_MAC).remove(KEY_PAIRED_NAME).apply()
        handler.removeCallbacks(bleReconnect)
        handler.removeCallbacks(rssiPoll)
        lastConnectedDevice = null
        closeGatt()
        BridgeEngine.watchConnected = false
        BridgeEngine.watchName = ""
        BridgeEngine.resetVitals()
        pushNotification("Watch unpaired")
    }

    private fun closeGatt() {
        try {
            bluetoothGatt?.disconnect()
        } catch (_: Exception) {
        }
        try {
            bluetoothGatt?.close()
        } catch (_: Exception) {
        }
        bluetoothGatt = null
    }

    private val bleReconnect = Runnable {
        val mac = lastConnectedDevice?.address ?: prefs().getString(KEY_PAIRED_MAC, "").orEmpty()
        if (mac.isNotEmpty() && !BridgeEngine.watchConnected) connectToWatchByMac(mac)
    }

    private val rssiPoll = object : Runnable {
        override fun run() {
            try {
                if (hasConnectPermission()) bluetoothGatt?.readRemoteRssi()
            } catch (_: SecurityException) {
            }
            if (bluetoothGatt != null) handler.postDelayed(this, RSSI_POLL_MS)
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt?, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    Log.d(TAG, "GATT connected")
                    try {
                        if (hasConnectPermission()) {
                            gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                            gatt?.readRemoteRssi()
                            gatt?.discoverServices()
                        }
                    } catch (_: SecurityException) {
                    }
                    handler.removeCallbacks(rssiPoll)
                    handler.postDelayed(rssiPoll, RSSI_POLL_MS)
                }

                BluetoothProfile.STATE_DISCONNECTED -> {
                    Log.d(TAG, "GATT disconnected, retrying in 3 s")
                    handler.removeCallbacks(rssiPoll)
                    closeGatt()
                    BridgeEngine.watchConnected = false
                    pushNotification(statusLine())
                    handler.removeCallbacks(bleReconnect)
                    handler.postDelayed(bleReconnect, BLE_RECONNECT_MS)
                }
            }
        }

        override fun onReadRemoteRssi(gatt: BluetoothGatt?, rssi: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                lastRssi = rssi
                BridgeEngine.lastRssi = rssi
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt?, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) return
            val characteristic = gatt?.getService(HEART_RATE_SERVICE_UUID)
                ?.getCharacteristic(HEART_RATE_CHAR_UUID)
            if (characteristic == null) {
                Log.e(TAG, "no heart-rate characteristic on this device")
                pushNotification("Device has no heart-rate service")
                return
            }
            try {
                if (!hasConnectPermission()) return
                gatt.setCharacteristicNotification(characteristic, true)

                val descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID)
                if (descriptor == null) {
                    Log.e(TAG, "CCCD descriptor missing")
                    return
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                } else {
                    @Suppress("DEPRECATION")
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(descriptor)
                }
                BridgeEngine.watchConnected = true
                pushNotification(statusLine())
            } catch (_: SecurityException) {
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt?,
            characteristic: BluetoothGattCharacteristic?
        ) {
            if (characteristic?.uuid == HEART_RATE_CHAR_UUID) {
                @Suppress("DEPRECATION")
                parseHeartRatePacket(characteristic.value)
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            if (characteristic.uuid == HEART_RATE_CHAR_UUID) parseHeartRatePacket(value)
        }
    }

    /**
     * Bluetooth SIG Heart Rate Measurement (0x2A37).
     * bit0 = 16-bit BPM, bits1-2 = sensor contact, bit3 = energy expended present,
     * bit4 = RR intervals present (units of 1/1024 s).
     */
    private fun parseHeartRatePacket(value: ByteArray?) {
        if (value == null || value.size < 2) return

        val flags = value[0].toInt() and 0xFF
        var index = 1

        val bpm: Int
        if (flags and 0x01 != 0) {
            if (value.size < index + 2) return
            bpm = ((value[index + 1].toInt() and 0xFF) shl 8) or (value[index].toInt() and 0xFF)
            index += 2
        } else {
            bpm = value[index].toInt() and 0xFF
            index += 1
        }

        val contact = (flags and 0x06) == 0x06

        // Energy expended (uint16) sits between the BPM and the RR list when bit3 is set.
        if (flags and 0x08 != 0) index += 2

        var rr = 0
        if (flags and 0x10 != 0 && index + 1 < value.size) {
            val raw = ((value[index + 1].toInt() and 0xFF) shl 8) or (value[index].toInt() and 0xFF)
            rr = (raw * 1000.0 / 1024.0).roundToInt()
        }

        BridgeEngine.notifyBpmUpdated(bpm)

        if (bpm > HIGH_HR_THRESHOLD) triggerHapticAlert()

        sendVitals(bpm, rr, contact)
    }

    private fun sendVitals(bpm: Int, rr: Int, contact: Boolean) {
        if (!pcLink.isConnected) return
        try {
            val json = JSONObject().apply {
                put("bpm", bpm)
                put("rr", rr)
                put("contact", contact)
                put("battery", batteryLevel())
                put("rssi", lastRssi)
            }
            pcLink.send(json.toString())
        } catch (e: Exception) {
            Log.e(TAG, "vitals send failed", e)
        }
    }

    private fun batteryLevel(): Int = try {
        (getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    } catch (e: Exception) {
        -1
    }

    /** Buzz on a dangerous heart rate, but at most once per 10 s so it stays a signal. */
    private fun triggerHapticAlert() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastHapticAt < HAPTIC_MIN_GAP_MS) return
        lastHapticAt = now
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 120, 60, 120), -1))
        } catch (_: Exception) {
        }
    }

    // ==================================================================
    // Notification
    // ==================================================================

    private fun statusLine(): String {
        val watch = when {
            BridgeEngine.watchConnected -> "Watch streaming"
            BridgeEngine.isScanning -> "Scanning…"
            else -> "Watch offline"
        }
        val pc = if (BridgeEngine.pcConnected) pcLink.describe() else "PC offline"
        return "$watch  •  $pc"
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "PulseNX Bridge",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the vitals bridge alive in the background"
            setShowBadge(false)
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    private fun pushNotification(text: String) {
        notificationText = text
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), flags
        )
        val rescan = PendingIntent.getService(
            this, 1,
            Intent(this, VitalsBridgeService::class.java).setAction(ACTION_START_SCAN), flags
        )
        val disconnect = PendingIntent.getService(
            this, 2,
            Intent(this, VitalsBridgeService::class.java).setAction(ACTION_DISCONNECT_PC), flags
        )

        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(
                if (BridgeEngine.lastBpm > 0) "PulseNX Bridge — ${BridgeEngine.lastBpm} BPM"
                else "PulseNX Bridge"
            )
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_pulsenx)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, R.drawable.ic_stat_pulsenx),
                    "Rescan Watch", rescan
                ).build()
            )
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, R.drawable.ic_stat_pulsenx),
                    "Disconnect", disconnect
                ).build()
            )
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
