package com.pulsenx.bridge

import android.Manifest
import android.content.Context
import android.content.Intent
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
import android.widget.TextView
import android.widget.Toast

/**
 * Single-screen control surface. All real work happens in [VitalsBridgeService];
 * this only renders [BridgeEngine] state and fires intents at the service.
 */
class MainActivity : android.app.Activity() {

    private companion object {
        const val PERM_REQUEST = 101
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
        renderState()
        renderBpm(BridgeEngine.lastBpm)
    }

    override fun onPause() {
        super.onPause()
        BridgeEngine.uiBpmListener = null
        BridgeEngine.uiStatusListener = null
    }

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

        getSharedPreferences(VitalsBridgeService.PREFS, Context.MODE_PRIVATE)
            .getString(VitalsBridgeService.KEY_PC_TARGET, "")
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

        renderState()
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
