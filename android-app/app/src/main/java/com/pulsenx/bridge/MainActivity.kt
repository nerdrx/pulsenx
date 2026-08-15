package com.pulsenx.bridge

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Single-screen control surface. All real work happens in [VitalsBridgeService];
 * this only renders [BridgeEngine] state and fires intents at the service.
 */
class MainActivity : android.app.Activity() {

    private companion object {
        const val PERM_REQUEST = 101
        const val HC_PERM_REQUEST = 102
        const val COLOR_OK = 0xFF3ddc84.toInt()
        const val COLOR_WARN = 0xFFffb020.toInt()
        const val COLOR_BAD = 0xFFff2d55.toInt()
        const val COLOR_MUTED = 0xFF9b8fb5.toInt()
    }

    private lateinit var etTarget: EditText
    private lateinit var btnLinkPc: Button
    private lateinit var btnScanWatch: Button
    private lateinit var tvStatusPc: TextView
    private lateinit var tvStatusWatch: TextView
    private lateinit var tvBpm: TextView
    private lateinit var progress: ProgressBar

    private lateinit var segSourceBle: TextView
    private lateinit var segSourceHealth: TextView
    private lateinit var groupWatch: View

    private lateinit var btnHcPermissions: Button
    private lateinit var switchHcWrite: Switch
    private lateinit var switchFitMirror: Switch
    private lateinit var tvHealthStatus: TextView
    private lateinit var tvHealthSteps: TextView
    private lateinit var tvHealthKcal: TextView
    private lateinit var tvHealthSleep: TextView
    private lateinit var tvHealthRhr: TextView

    /** Health Connect permission queries are suspend-only; this scope owns them. */
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val hcContract by lazy { PermissionController.createRequestPermissionResultContract() }

    /** Cached grant set, refreshed on resume and after every permission round-trip. */
    private var hcGranted: Set<String> = emptySet()

    /** Guards the switches while we set their state programmatically. */
    private var bindingSwitches = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        bindViews()
        requestBatteryOptimizationBypass()

        if (!hasRequiredPermissions()) requestRequiredPermissions()

        startBridgeService(Intent(this, VitalsBridgeService::class.java))
    }

    override fun onResume() {
        super.onResume()
        BridgeEngine.uiBpmListener = { bpm -> renderBpm(bpm) }
        BridgeEngine.uiStatusListener = { renderState() }
        BridgeEngine.uiHealthListener = { renderHealth() }
        renderState()
        renderBpm(BridgeEngine.lastBpm)
        renderHealth()
        refreshHealthConnectState()
    }

    override fun onPause() {
        super.onPause()
        BridgeEngine.uiBpmListener = null
        BridgeEngine.uiStatusListener = null
        BridgeEngine.uiHealthListener = null
    }

    override fun onDestroy() {
        super.onDestroy()
        uiScope.cancel()
    }

    private fun prefs(): SharedPreferences =
        getSharedPreferences(VitalsBridgeService.PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

    private fun bindViews() {
        etTarget = findViewById(R.id.etTarget)
        btnLinkPc = findViewById(R.id.btnLinkPc)
        btnScanWatch = findViewById(R.id.btnScanWatch)
        tvStatusPc = findViewById(R.id.tvStatusPc)
        tvStatusWatch = findViewById(R.id.tvStatusWatch)
        tvBpm = findViewById(R.id.tvBpm)
        progress = findViewById(R.id.progressScan)

        segSourceBle = findViewById(R.id.segSourceBle)
        segSourceHealth = findViewById(R.id.segSourceHealth)
        groupWatch = findViewById(R.id.groupWatch)

        btnHcPermissions = findViewById(R.id.btnHcPermissions)
        switchHcWrite = findViewById(R.id.switchHcWrite)
        switchFitMirror = findViewById(R.id.switchFitMirror)
        tvHealthStatus = findViewById(R.id.tvHealthStatus)
        tvHealthSteps = findViewById(R.id.tvHealthSteps)
        tvHealthKcal = findViewById(R.id.tvHealthKcal)
        tvHealthSleep = findViewById(R.id.tvHealthSleep)
        tvHealthRhr = findViewById(R.id.tvHealthRhr)

        prefs().getString(VitalsBridgeService.KEY_PC_TARGET, "")
            ?.takeIf { it.isNotEmpty() }
            ?.let { etTarget.setText(it) }

        btnLinkPc.setOnClickListener {
            if (BridgeEngine.pcConnected) {
                sendServiceAction(VitalsBridgeService.ACTION_DISCONNECT_PC)
                return@setOnClickListener
            }
            if (!hasRequiredPermissions()) {
                requestRequiredPermissions()
                return@setOnClickListener
            }
            val target = etTarget.text.toString().trim()
            if (target.isEmpty()) {
                toast("Enter a link code or your PC's LAN IP")
                return@setOnClickListener
            }
            hideKeyboard()
            startBridgeService(
                Intent(this, VitalsBridgeService::class.java)
                    .setAction(VitalsBridgeService.ACTION_LINK_PC)
                    .putExtra(VitalsBridgeService.EXTRA_PC_TARGET, target)
            )
            toast(
                if (target.contains(".")) "Linking over LAN to $target…"
                else "Linking via cloud code ${target.uppercase()}…"
            )
        }

        btnScanWatch.setOnClickListener {
            if (!hasRequiredPermissions()) {
                requestRequiredPermissions()
                return@setOnClickListener
            }
            sendServiceAction(
                if (BridgeEngine.isScanning) VitalsBridgeService.ACTION_STOP_SCAN
                else VitalsBridgeService.ACTION_START_SCAN
            )
        }

        btnScanWatch.setOnLongClickListener {
            sendServiceAction(VitalsBridgeService.ACTION_UNPAIR_WATCH)
            toast("Watch unpaired")
            true
        }

        bindHealthViews()
        renderState()
    }

    private fun bindHealthViews() {
        segSourceBle.setOnClickListener { selectSource(VitalsBridgeService.SOURCE_BLE) }
        segSourceHealth.setOnClickListener { selectSource(VitalsBridgeService.SOURCE_HEALTH) }
        renderSourceSelection(currentSource())

        btnHcPermissions.setOnClickListener { requestHealthPermissions(HealthConnectHub.ALL_PERMISSIONS) }
        // The status line doubles as the "install / update / grant" affordance.
        tvHealthStatus.setOnClickListener { resolveHealthConnectBlock() }

        bindingSwitches = true
        switchHcWrite.isChecked = prefs().getBoolean(VitalsBridgeService.KEY_HC_WRITE, false)
        switchFitMirror.isChecked = prefs().getBoolean(VitalsBridgeService.KEY_FIT_MIRROR, false)
        bindingSwitches = false

        switchHcWrite.setOnCheckedChangeListener { _, checked ->
            if (bindingSwitches) return@setOnCheckedChangeListener
            if (checked && !guardHealthConnectAvailable(switchHcWrite)) return@setOnCheckedChangeListener
            prefs().edit().putBoolean(VitalsBridgeService.KEY_HC_WRITE, checked).apply()
            if (checked && !hcGranted.contains(HealthConnectHub.WRITE_HEART_RATE)) {
                toast(getString(R.string.health_toast_write_permission))
                requestHealthPermissions(HealthConnectHub.WRITE_PERMISSIONS)
            }
        }

        switchFitMirror.setOnCheckedChangeListener { _, checked ->
            if (bindingSwitches) return@setOnCheckedChangeListener
            if (checked && !guardHealthConnectAvailable(switchFitMirror)) return@setOnCheckedChangeListener
            prefs().edit().putBoolean(VitalsBridgeService.KEY_FIT_MIRROR, checked).apply()
            if (checked) {
                HealthSyncWorker.enqueue(this)
                toast(getString(R.string.health_toast_mirror_on))
                if (!hcGranted.containsAll(HealthConnectHub.ALL_PERMISSIONS)) {
                    requestHealthPermissions(HealthConnectHub.ALL_PERMISSIONS)
                }
            } else {
                HealthSyncWorker.cancel(this)
                toast(getString(R.string.health_toast_mirror_off))
            }
        }
    }

    /** Flips a switch back off (silently) when Health Connect cannot serve it. */
    private fun guardHealthConnectAvailable(target: Switch): Boolean {
        if (HealthConnectHub.isAvailable(this)) return true
        toast(getString(R.string.health_toast_unavailable))
        bindingSwitches = true
        target.isChecked = false
        bindingSwitches = false
        openHealthConnectListing()
        return false
    }

    private fun currentSource(): String =
        prefs().getString(VitalsBridgeService.KEY_HR_SOURCE, VitalsBridgeService.SOURCE_BLE)
            .orEmpty()
            .ifEmpty { VitalsBridgeService.SOURCE_BLE }

    private fun selectSource(source: String) {
        if (source == VitalsBridgeService.SOURCE_HEALTH && !HealthConnectHub.isAvailable(this)) {
            toast(getString(R.string.health_toast_unavailable))
            openHealthConnectListing()
            return
        }

        prefs().edit().putString(VitalsBridgeService.KEY_HR_SOURCE, source).apply()
        renderSourceSelection(source)
        startBridgeService(
            Intent(this, VitalsBridgeService::class.java)
                .setAction(VitalsBridgeService.ACTION_SET_SOURCE)
                .putExtra(VitalsBridgeService.EXTRA_HR_SOURCE, source)
        )

        val label = getString(
            if (source == VitalsBridgeService.SOURCE_HEALTH) R.string.source_health
            else R.string.source_ble
        )
        toast(getString(R.string.health_toast_source, label))

        if (source == VitalsBridgeService.SOURCE_HEALTH &&
            !hcGranted.contains(HealthConnectHub.READ_HEART_RATE)
        ) {
            requestHealthPermissions(HealthConnectHub.READ_PERMISSIONS)
        }
    }

    private fun renderSourceSelection(source: String) {
        val health = source == VitalsBridgeService.SOURCE_HEALTH
        segSourceBle.isSelected = !health
        segSourceHealth.isSelected = health
        groupWatch.visibility = if (health) View.GONE else View.VISIBLE
    }

    private fun renderState() {
        if (BridgeEngine.pcConnected) {
            val detail = BridgeEngine.pcDetail.ifEmpty { "Linked" }
            tvStatusPc.text = detail
            tvStatusPc.setTextColor(COLOR_OK)
            btnLinkPc.text = getString(R.string.action_unlink_pc)
        } else {
            tvStatusPc.text = BridgeEngine.pcDetail.ifEmpty { getString(R.string.status_pc_offline) }
            tvStatusPc.setTextColor(if (BridgeEngine.pcDetail.isEmpty()) COLOR_BAD else COLOR_WARN)
            btnLinkPc.text = getString(R.string.action_link_pc)
        }

        when {
            BridgeEngine.watchConnected -> {
                tvStatusWatch.text = BridgeEngine.watchName.ifEmpty { getString(R.string.status_watch_live) }
                tvStatusWatch.setTextColor(COLOR_OK)
                btnScanWatch.text = getString(R.string.action_watch_linked)
                progress.visibility = View.GONE
            }

            BridgeEngine.isScanning -> {
                tvStatusWatch.text = getString(R.string.status_watch_scanning)
                tvStatusWatch.setTextColor(COLOR_WARN)
                btnScanWatch.text = getString(R.string.action_stop_scan)
                progress.visibility = View.VISIBLE
            }

            else -> {
                tvStatusWatch.text = getString(R.string.status_watch_offline)
                tvStatusWatch.setTextColor(COLOR_BAD)
                btnScanWatch.text = getString(R.string.action_scan_watch)
                progress.visibility = View.GONE
            }
        }

        // The pref is authoritative: it is written before the service is told to switch,
        // so the segmented control is correct even before the service has come up.
        renderSourceSelection(currentSource())
    }

    private fun renderBpm(bpm: Int) {
        if (bpm <= 0) {
            tvBpm.text = "--"
            tvBpm.setTextColor(COLOR_MUTED)
            return
        }
        tvBpm.text = bpm.toString()
        tvBpm.setTextColor(COLOR_BAD)
        tvBpm.animate()
            .scaleX(1.12f).scaleY(1.12f).setDuration(90)
            .withEndAction {
                tvBpm.animate().scaleX(1f).scaleY(1f).setDuration(140).start()
            }
            .start()
    }

    // ------------------------------------------------------------------
    // Health card
    // ------------------------------------------------------------------

    private fun renderHealth() {
        val none = getString(R.string.health_value_none)
        val summary = BridgeEngine.lastHealthSummary

        when (HealthConnectHub.sdkStatus(this)) {
            HealthConnectClient.SDK_UNAVAILABLE -> {
                tvHealthStatus.text = getString(R.string.health_status_missing)
                tvHealthStatus.setTextColor(COLOR_BAD)
            }

            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                tvHealthStatus.text = getString(R.string.health_status_update)
                tvHealthStatus.setTextColor(COLOR_WARN)
            }

            else -> when {
                !hcGranted.containsAll(HealthConnectHub.READ_PERMISSIONS) -> {
                    tvHealthStatus.text = getString(R.string.health_status_permission)
                    tvHealthStatus.setTextColor(COLOR_WARN)
                }

                summary == null -> {
                    tvHealthStatus.text = getString(R.string.health_status_waiting)
                    tvHealthStatus.setTextColor(COLOR_MUTED)
                }

                else -> {
                    tvHealthStatus.text = getString(R.string.health_status_ready, summary.source)
                    tvHealthStatus.setTextColor(COLOR_OK)
                }
            }
        }

        tvHealthSteps.text = summary?.steps
            ?.let { String.format(Locale.getDefault(), "%,d", it) } ?: none

        // Active calories are the interesting number; total is a fallback.
        tvHealthKcal.text = (summary?.activeKcal ?: summary?.totalKcal)
            ?.let { getString(R.string.health_value_kcal, it.toInt()) } ?: none

        tvHealthSleep.text = summary?.sleepMin
            ?.let { getString(R.string.health_value_sleep, it / 60, it % 60) } ?: none

        tvHealthRhr.text = (summary?.restingBpm ?: summary?.avgBpm)
            ?.let { getString(R.string.health_value_bpm, it) } ?: none
    }

    /** Refreshes the cached grant set, then re-renders and asks for a fresh summary. */
    private fun refreshHealthConnectState() {
        if (!HealthConnectHub.isAvailable(this)) {
            hcGranted = emptySet()
            renderHealth()
            return
        }
        uiScope.launch {
            hcGranted = HealthConnectHub.grantedPermissions(this@MainActivity)
            renderHealth()
            if (hcGranted.containsAll(HealthConnectHub.READ_PERMISSIONS)) {
                sendServiceAction(VitalsBridgeService.ACTION_REFRESH_HEALTH)
            }
        }
    }

    /** Tapping the status line does whatever is currently blocking Health Connect. */
    private fun resolveHealthConnectBlock() {
        when (HealthConnectHub.sdkStatus(this)) {
            HealthConnectClient.SDK_UNAVAILABLE,
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED ->
                openHealthConnectListing()

            else -> requestHealthPermissions(HealthConnectHub.ALL_PERMISSIONS)
        }
    }

    private fun openHealthConnectListing() {
        // On Android 14+ Health Connect is a platform module: there is no Play listing to
        // open, so the only useful destination is its Settings screen.
        if (HealthConnectHub.isPlatformProvider) {
            try {
                startActivity(HealthConnectHub.settingsIntent())
                return
            } catch (_: Exception) {
                toast(getString(R.string.health_toast_unavailable))
                return
            }
        }
        try {
            startActivity(HealthConnectHub.installIntent())
        } catch (_: Exception) {
            try {
                startActivity(
                    Intent(
                        Intent.ACTION_VIEW,
                        Uri.parse(
                            "https://play.google.com/store/apps/details?id=" +
                                HealthConnectHub.PROVIDER_PACKAGE
                        )
                    )
                )
            } catch (_: Exception) {
                toast(getString(R.string.health_toast_unavailable))
            }
        }
    }

    /**
     * This is a plain [android.app.Activity], so there is no `registerForActivityResult`
     * to lean on: the Health Connect contract is driven by hand instead.
     */
    private fun requestHealthPermissions(wanted: Set<String>) {
        when (HealthConnectHub.sdkStatus(this)) {
            HealthConnectClient.SDK_UNAVAILABLE,
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                openHealthConnectListing()
                return
            }
        }
        try {
            startActivityForResult(hcContract.createIntent(this, wanted), HC_PERM_REQUEST)
        } catch (e: Exception) {
            toast(getString(R.string.health_toast_unavailable))
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != HC_PERM_REQUEST) return

        hcGranted = try {
            hcContract.parseResult(resultCode, data)
        } catch (_: Exception) {
            emptySet()
        }

        if (hcGranted.isEmpty()) toast(getString(R.string.health_status_denied))

        bindingSwitches = true
        if (!hcGranted.contains(HealthConnectHub.WRITE_HEART_RATE) && switchHcWrite.isChecked) {
            switchHcWrite.isChecked = false
            prefs().edit().putBoolean(VitalsBridgeService.KEY_HC_WRITE, false).apply()
        }
        if (!hcGranted.containsAll(HealthConnectHub.WRITE_PERMISSIONS) && switchFitMirror.isChecked) {
            switchFitMirror.isChecked = false
            prefs().edit().putBoolean(VitalsBridgeService.KEY_FIT_MIRROR, false).apply()
            HealthSyncWorker.cancel(this)
        }
        bindingSwitches = false

        renderHealth()
        if (hcGranted.containsAll(HealthConnectHub.READ_PERMISSIONS)) {
            sendServiceAction(VitalsBridgeService.ACTION_REFRESH_HEALTH)
        }
    }

    // ------------------------------------------------------------------
    // Service / permissions
    // ------------------------------------------------------------------

    private fun sendServiceAction(action: String) {
        startBridgeService(Intent(this, VitalsBridgeService::class.java).setAction(action))
    }

    private fun startBridgeService(intent: Intent) {
        try {
            startForegroundService(intent)
        } catch (e: Exception) {
            try {
                startService(intent)
            } catch (_: Exception) {
            }
        }
    }

    private fun requestBatteryOptimizationBypass() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(packageName)) return
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
            )
        } catch (_: Exception) {
        }
    }

    private fun hasRequiredPermissions(): Boolean {
        val bt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_SCAN) && granted(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        val notifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            granted(Manifest.permission.POST_NOTIFICATIONS)
        return bt && notifications
    }

    private fun granted(permission: String) =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun requestRequiredPermissions() {
        val wanted = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            wanted += Manifest.permission.BLUETOOTH_SCAN
            wanted += Manifest.permission.BLUETOOTH_CONNECT
        } else {
            wanted += Manifest.permission.ACCESS_FINE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted += Manifest.permission.POST_NOTIFICATIONS
        }
        requestPermissions(wanted.toTypedArray(), PERM_REQUEST)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST && !hasRequiredPermissions()) {
            toast("Bluetooth permissions are required to reach your watch")
        }
    }

    private fun hideKeyboard() {
        try {
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .hideSoftInputFromWindow(etTarget.windowToken, 0)
        } catch (_: Exception) {
        }
    }

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
}
