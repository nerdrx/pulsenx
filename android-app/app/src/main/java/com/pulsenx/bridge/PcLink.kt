package com.pulsenx.bridge

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.eclipse.paho.client.mqttv3.IMqttActionListener
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.IMqttToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The PC transport.
 *
 * Two modes, picked from what the user typed:
 *  - [Mode.LAN]   target contains a dot -> treated as an IP/hostname -> `ws://<ip>:9000` (OkHttp).
 *  - [Mode.CLOUD] target has no dot -> treated as a 6-char link code -> real MQTT (Eclipse Paho)
 *                 over `wss://broker.emqx.io:8084/mqtt`, topic `pulsenx/vitals/pc-<CODE>`.
 *
 * The old PulseLink build hand-assembled MQTT frames with a single-byte Remaining Length field,
 * which corrupted every packet larger than 127 bytes. Paho encodes the variable-length integer
 * correctly, so that class of bug is gone.
 */
class PcLink(private val context: Context, private val listener: Listener) {

    interface Listener {
        fun onLinkStateChanged(connected: Boolean, detail: String)
    }

    enum class Mode { NONE, LAN, CLOUD }

    companion object {
        private const val TAG = "PulseNX/PcLink"
        private const val PREFS = "PulseNXPrefs"
        private const val KEY_CLIENT_ID = "MQTT_CLIENT_ID"

        const val LAN_PORT = 9000
        const val MQTT_BROKER_URI = "wss://broker.emqx.io:8084/mqtt"
        const val TOPIC_PREFIX = "pulsenx/vitals/pc-"

        private const val LAN_RECONNECT_MS = 5_000L
        private const val HELLO = "\"HELLO\""
        private const val BYE = "\"BYE\""
    }

    private val handler = Handler(Looper.getMainLooper())

    @Volatile
    var isConnected = false
        private set

    var mode = Mode.NONE
        private set

    /** Cleaned target: bare IP/hostname in LAN mode, uppercase link code in cloud mode. */
    var target = ""
        private set

    private var userStopped = false

    // --- LAN (OkHttp WebSocket) ---
    private val http: OkHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private var webSocket: WebSocket? = null

    // --- Cloud (Paho MQTT) ---
    private var mqtt: MqttAsyncClient? = null
    private var mqttTopic = ""

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    fun connect(rawTarget: String) {
        val clean = sanitize(rawTarget)
        if (clean.isEmpty()) return

        userStopped = false
        teardown(publishBye = false)

        val isIp = clean.contains(".")
        mode = if (isIp) Mode.LAN else Mode.CLOUD
        target = if (isIp) clean else clean.uppercase()

        if (mode == Mode.LAN) openLan() else openCloud()
    }

    /** Reconnect the current target (network change, beacon, retry timer). */
    fun reconnect() {
        if (userStopped || target.isEmpty() || isConnected) return
        if (mode == Mode.LAN) openLan() else openCloud()
    }

    /** User-initiated stop: sends BYE in cloud mode, then closes everything. */
    fun disconnect() {
        userStopped = true
        handler.removeCallbacks(lanRetry)
        teardown(publishBye = true)
        mode = Mode.NONE
        target = ""
        setState(false, "")
    }

    fun shutdown() {
        userStopped = true
        handler.removeCallbacks(lanRetry)
        teardown(publishBye = false)
    }

    fun describe(): String = when (mode) {
        Mode.LAN -> "LAN $target"
        Mode.CLOUD -> "Cloud $target"
        Mode.NONE -> ""
    }

    /** Fire-and-forget vitals payload. Returns false if the socket rejected it. */
    fun send(payload: String): Boolean {
        if (!isConnected) return false
        return when (mode) {
            Mode.LAN -> {
                val ok = webSocket?.send(payload) ?: false
                if (!ok) {
                    Log.w(TAG, "LAN send rejected, socket buffer full or closed")
                    onLanDown("Send failed")
                }
                ok
            }

            Mode.CLOUD -> publishMqtt(payload, qos = 0)
            Mode.NONE -> false
        }
    }

    // ------------------------------------------------------------------
    // LAN transport
    // ------------------------------------------------------------------

    private fun openLan() {
        val url = "ws://$target:$LAN_PORT"
        Log.d(TAG, "LAN connect -> $url")
        try {
            webSocket = http.newWebSocket(Request.Builder().url(url).build(), lanListener)
        } catch (e: Exception) {
            Log.e(TAG, "LAN connect failed", e)
            scheduleLanRetry()
        }
    }

    private val lanListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            isConnected = true
            setState(true, "LAN $target")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            onLanDown(if (reason.isEmpty()) "closed" else reason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            onLanDown(t.message ?: "error")
        }
    }

    private fun onLanDown(reason: String) {
        if (!isConnected && userStopped) return
        Log.d(TAG, "LAN down: $reason")
        isConnected = false
        webSocket = null
        setState(false, "Retrying in 5 s")
        scheduleLanRetry()
    }

    private fun scheduleLanRetry() {
        if (userStopped) return
        handler.removeCallbacks(lanRetry)
        handler.postDelayed(lanRetry, LAN_RECONNECT_MS)
    }

    private val lanRetry = Runnable {
        if (!userStopped && !isConnected && mode == Mode.LAN && target.isNotEmpty()) openLan()
    }

    // ------------------------------------------------------------------
    // Cloud transport (Paho MQTT over WSS)
    // ------------------------------------------------------------------

    private fun openCloud() {
        mqttTopic = TOPIC_PREFIX + target
        val clientId = getOrCreateClientId()
        setState(false, "Connecting to cloud…")

        thread(name = "PulseNX-MQTT-Connect") {
            try {
                val client = MqttAsyncClient(MQTT_BROKER_URI, clientId, MemoryPersistence())
                mqtt = client
                client.setCallback(mqttCallback)

                val opts = MqttConnectOptions().apply {
                    isCleanSession = true
                    isAutomaticReconnect = true
                    keepAliveInterval = 60
                    connectionTimeout = 20
                    maxInflight = 50
                    mqttVersion = MqttConnectOptions.MQTT_VERSION_3_1_1
                    // If the phone drops off the network the broker announces it for us.
                    setWill(mqttTopic, BYE.toByteArray(Charsets.UTF_8), 1, false)
                }

                client.connect(opts, null, object : IMqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {
                        Log.d(TAG, "MQTT connected, topic=$mqttTopic")
                    }

                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        Log.e(TAG, "MQTT connect failed: ${exception?.message}")
                        isConnected = false
                        setState(false, "Cloud error, retrying…")
                    }
                })
            } catch (e: Exception) {
                Log.e(TAG, "MQTT client setup failed", e)
                isConnected = false
                setState(false, "Cloud error")
            }
        }
    }

    private val mqttCallback = object : MqttCallbackExtended {
        override fun connectComplete(reconnect: Boolean, serverURI: String?) {
            isConnected = true
            setState(true, "Cloud $target")
            publishMqtt(HELLO, qos = 1)
        }

        override fun connectionLost(cause: Throwable?) {
            Log.w(TAG, "MQTT connection lost: ${cause?.message}")
            isConnected = false
            if (!userStopped) setState(false, "Cloud dropped, reconnecting…")
        }

        override fun messageArrived(topic: String?, message: MqttMessage?) = Unit
        override fun deliveryComplete(token: IMqttDeliveryToken?) = Unit
    }

    private fun publishMqtt(payload: String, qos: Int): Boolean {
        val client = mqtt ?: return false
        return try {
            if (!client.isConnected) return false
            client.publish(mqttTopic, MqttMessage(payload.toByteArray(Charsets.UTF_8)).apply {
                this.qos = qos
                isRetained = false
            })
            true
        } catch (e: Exception) {
            Log.e(TAG, "MQTT publish failed: ${e.message}")
            false
        }
    }

    private fun getOrCreateClientId(): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var id = prefs.getString(KEY_CLIENT_ID, null)
        if (id.isNullOrEmpty()) {
            id = "pulsenx-phone-${(10000..99999).random()}"
            prefs.edit().putString(KEY_CLIENT_ID, id).apply()
        }
        return id
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private fun teardown(publishBye: Boolean) {
        val ws = webSocket
        webSocket = null
        try {
            ws?.close(1000, "PulseNX closing")
        } catch (_: Exception) {
        }

        val client = mqtt
        mqtt = null
        isConnected = false

        if (client != null) {
            val sayBye = publishBye && mqttTopic.isNotEmpty()
            thread(name = "PulseNX-MQTT-Close") {
                try {
                    if (client.isConnected) {
                        if (sayBye) {
                            client.publish(
                                mqttTopic,
                                MqttMessage(BYE.toByteArray(Charsets.UTF_8)).apply {
                                    qos = 1
                                    isRetained = false
                                }
                            ).waitForCompletion(2000)
                        }
                        client.disconnect(1000).waitForCompletion(3000)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "MQTT close: ${e.message}")
                } finally {
                    try {
                        client.close(true)
                    } catch (_: Exception) {
                    }
                }
            }
        }
    }

    private fun setState(connected: Boolean, detail: String) {
        handler.post { listener.onLinkStateChanged(connected, detail) }
    }

    private fun sanitize(raw: String): String {
        var clean = raw.trim()
            .removePrefix("http://").removePrefix("https://")
            .removePrefix("ws://").removePrefix("wss://")
        clean = clean.substringBefore('/')
        if (clean.contains(':')) clean = clean.substringBefore(':')
        return clean
    }
}
