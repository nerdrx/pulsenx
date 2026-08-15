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
import android.text.Editable
import android.text.TextWatcher
import android.text.format.DateFormat
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
import java.util.Date
import java.util.Locale

/**
 * Single-screen control surface. All real work happens in [VitalsBridgeService];
 * this only renders [BridgeEngine] state and fires intents at the service.
 */
class MainActivity : android.app.Activity() {

    private companion object {
        const val PERM_REQUEST = 101
        const val HC_PERM_REQUEST = 102
        const val HW_AUTH_REQUEST = 103
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

    private lateinit var etHwClientId: EditText
    private lateinit var etHwClientSecret: EditText
    private lateinit var btnHwLink: Button
    private lateinit var tvHwStatus: TextView

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

        etHwClientId = findViewById(R.id.etHwClientId)
        etHwClientSecret = findViewById(R.id.etHwClientSecret)
        btnHwLink = findViewById(R.id.btnHwLink)
        tvHwStatus = findViewById(R.id.tvHwStatus)

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
        bindHuaweiViews()
        renderState()
    }

    // ------------------------------------------------------------------
    // Huawei Health Kit cloud link
    // ------------------------------------------------------------------

    private fun bindHuaweiViews() {
        etHwClientId.setText(HuaweiCloud.clientId(this))
        etHwClientSecret.setText(HuaweiCloud.clientSecret(this))

        // Credentials persist as they are typed: pasting an ID, backgrounding the app
        // to fetch the secret and coming back must not lose the first field.
        val persist = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                HuaweiCloud.saveCredentials(
                    this@MainActivity,
                    etHwClientId.text.toString(),
                    etHwClientSecret.text.toString()
                )
                renderHuawei()
            }
        }
        etHwClientId.addTextChangedListener(persist)
        etHwClientSecret.addTextChangedListener(persist)

        btnHwLink.setOnClickListener {
            if (HuaweiCloud.isLinked(this)) {
                HuaweiCloud.clear(this)
                toast(getString(R.string.hw_toast_unlinked))
                renderHuawei()
                return@setOnClickListener
            }
            if (!HuaweiCloud.hasCredentials(this)) {
                toast(getString(R.string.hw_error_no_credentials))
                return@setOnClickListener
            }
            hideKeyboard()
            try {
                startActivityForResult(
                    Intent(this, HuaweiAuthActivity::class.java), HW_AUTH_REQUEST
                )
            } catch (_: Exception) {
                toast(getString(R.string.hw_error_generic, "no browser component"))
            }
        }

        renderHuawei()
    }

    /**
     * Four states, in the order they block each other: no credentials → not linked →
     * expired → linked. "Linked as of" carries the last successful cloud round-trip,
     * which is the only thing that proves the token still works.
     */
    private fun renderHuawei() {
        val linked = HuaweiCloud.isLinked(this)
        val hasCredentials = HuaweiCloud.hasCredentials(this)

        btnHwLink.text = getString(
            if (linked) R.string.hw_action_unlink else R.string.hw_action_link
        )
        btnHwLink.isEnabled = linked || hasCredentials
        btnHwLink.alpha = if (btnHwLink.isEnabled) 1f else 0.45f

        when {
            !linked && !hasCredentials -> {
                tvHwStatus.text = getString(R.string.hw_status_credentials)
                tvHwStatus.setTextColor(COLOR_MUTED)
            }

            !linked -> {
                tvHwStatus.text = getString(R.string.hw_status_not_linked)
                tvHwStatus.setTextColor(COLOR_MUTED)
            }

            HuaweiCloud.isAuthBroken(this) -> {
                tvHwStatus.text = getString(R.string.hw_status_expired)
                tvHwStatus.setTextColor(COLOR_BAD)
            }

            else -> {
                val at = HuaweiCloud.lastOkAt(this)
                val stamp = if (at > 0L) {
                    DateFormat.getTimeFormat(this).format(Date(at))
                } else {
                    "—"
                }
                tvHwStatus.text = getString(R.string.hw_status_linked, stamp)
                tvHwStatus.setTextColor(COLOR_OK)
            }
        }
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
                // Kick the first (backfill) pass right away via the service instead of
                // waiting out WorkManager's first 15-minute period.
                sendServiceAction(VitalsBridgeService.ACTION_MIRROR_NOW)
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

        // The cloud link has its own state machine; keep it in step with every
        // summary that lands, since a successful read is what refreshes its stamp.
        renderHuawei()
    }

    /** Refreshes the cached grant set, then re-renders and asks for a fresh summary. */
    private fun refreshHealthConnectState() {
        // A linked Huawei cloud account produces a summary on its own, so it is
        // reason enough to ask the service for a refresh even with no Health Connect.
        val cloudLinked = HuaweiCloud.isLinked(this)
        if (!HealthConnectHub.isAvailable(this)) {
            hcGranted = emptySet()
            renderHealth()
            if (cloudLinked) sendServiceAction(VitalsBridgeService.ACTION_REFRESH_HEALTH)
            return
        }
        uiScope.launch {
            hcGranted = HealthConnectHub.grantedPermissions(this@MainActivity)
            renderHealth()
            if (cloudLinked || hcGranted.containsAll(HealthConnectHub.READ_PERMISSIONS)) {
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
     * to lean on.
     *
     * On Android 14+ health permissions are ordinary runtime permissions, and the
     * connect-client contract reflects that: `createIntent` returns androidx's SYNTHETIC
     * `action.REQUEST_PERMISSIONS` intent, which only the androidx ActivityResult
     * registry knows how to translate into a real permission request. Fired raw through
     * `startActivityForResult` it resolves to nothing (verified on-device: ActivityTaskManager
     * result -91). So on 34+ the request goes through the platform's own
     * [requestPermissions]; the hand-driven contract stays for the pre-14 provider APK,
     * whose contract returns a real launchable intent.
     */
    private fun requestHealthPermissions(wanted: Set<String>) {
        when (HealthConnectHub.sdkStatus(this)) {
            HealthConnectClient.SDK_UNAVAILABLE,
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                openHealthConnectListing()
                return
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            requestPermissions(wanted.toTypedArray(), HC_PERM_REQUEST)
            return
        }
        try {
            startActivityForResult(hcContract.createIntent(this, wanted), HC_PERM_REQUEST)
        } catch (e: Exception) {
            toast(getString(R.string.health_toast_unavailable))
        }
    }

    /**
     * Shared landing point for both grant flows: [onActivityResult] (pre-14 contract)
     * and [onRequestPermissionsResult] (14+ runtime permissions). Reconciles the switch
     * states with what actually got granted.
     */
    private fun onHealthPermissionOutcome(granted: Set<String>) {
        hcGranted = granted

        if (hcGranted.isEmpty()) toast(getString(R.string.health_status_denied))
        // Everything granted looks like "nothing happened" (Android shows no UI when
        // there is nothing left to ask), so say it out loud.
        else if (hcGranted.containsAll(HealthConnectHub.ALL_PERMISSIONS)) {
            toast(getString(R.string.health_status_all_granted))
        }

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

    /** Pre-Android-14 grant flow: the provider-APK contract round-trip. */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == HW_AUTH_REQUEST) {
            if (resultCode == RESULT_OK) {
                toast(getString(R.string.hw_toast_linked))
                // The service owns the readers; ask it for a summary now rather than
                // waiting out the 5-minute tick.
                sendServiceAction(VitalsBridgeService.ACTION_REFRESH_HEALTH)
            }
            // The auth activity already surfaced its own reason as a toast; the status
            // line just re-reads whatever state it left behind.
            renderHuawei()
            return
        }

        if (requestCode != HC_PERM_REQUEST) return

        val granted = try {
            hcContract.parseResult(resultCode, data)
        } catch (_: Exception) {
            emptySet()
        }
        onHealthPermissionOutcome(granted)
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
        if (requestCode == HC_PERM_REQUEST) {
            // Android 14+ health grant flow. The callback's grantResults only cover
            // what was just asked for; the permission controller is the authority on
            // the full grant set, so it is re-queried instead of parsed from here.
            uiScope.launch {
                onHealthPermissionOutcome(HealthConnectHub.grantedPermissions(this@MainActivity))
            }
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
