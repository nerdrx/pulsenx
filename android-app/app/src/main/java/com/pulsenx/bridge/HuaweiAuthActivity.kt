package com.pulsenx.bridge

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The Huawei ID consent screen, hosted in-app.
 *
 * The OAuth callback (`https://pulsenx.auth/callback`) resolves to nothing on the
 * public internet by design: this activity kills the navigation the instant the
 * WebView tries to go there and reads `?code=` straight out of the URL. Nothing is
 * ever sent to that host, so there is no third party in the loop.
 *
 * Launched only from [MainActivity] (`exported="false"`); the result is
 * [RESULT_OK] once the code has been exchanged for tokens, [RESULT_CANCELED]
 * otherwise, with [EXTRA_ERROR] carrying the reason when there is one.
 */
class HuaweiAuthActivity : Activity() {

    companion object {
        private const val TAG = "PulseNX/HuaweiAuth"
        const val EXTRA_ERROR = "error"

        /** NX dark, one shade above the aurora void so the WebView reads as a sheet. */
        private const val NX_SHEET = 0xFF0a0512.toInt()
    }

    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var title: TextView

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** CSRF nonce; the callback must echo it back unchanged. */
    private var state: String = ""

    /** The callback fires once — a second navigation must not re-exchange the code. */
    private var handled = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val clientId = HuaweiCloud.clientId(this)
        if (clientId.isEmpty()) {
            finishWith(getString(R.string.hw_error_no_credentials))
            return
        }

        setContentView(buildLayout())

        state = HuaweiCloud.newState()

        // A stale Huawei session would silently relink whatever account is cached.
        // Linking is an explicit act, so it always starts from a clean sheet.
        try {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        } catch (e: Exception) {
            Log.w(TAG, "cookie reset failed: ${e.message}")
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        web.setBackgroundColor(NX_SHEET)
        web.webViewClient = client

        val url = HuaweiCloud.buildAuthorizeUrl(clientId, state)
        Log.d(TAG, "authorize URL: $url")
        web.loadUrl(url)
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
        try {
            web.stopLoading()
            web.destroy()
        } catch (_: Exception) {
        }
    }

    // ------------------------------------------------------------------
    // Navigation interception
    // ------------------------------------------------------------------

    private val client = object : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            intercept(request.url?.toString())

        @Deprecated("Deprecated in Java")
        override fun shouldOverrideUrlLoading(view: WebView, url: String?): Boolean = intercept(url)

        override fun onPageFinished(view: WebView?, url: String?) {
            progress.visibility = View.GONE
            // Some Huawei error paths land on the callback via a server-side redirect
            // the shouldOverrideUrlLoading hook never sees; check the settled URL too.
            intercept(url)
        }

        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
            progress.visibility = View.VISIBLE
            intercept(url)
        }
    }

    /** True when [url] was the OAuth callback and this activity swallowed it. */
    private fun intercept(url: String?): Boolean {
        if (url == null || handled) return false
        if (!url.startsWith(HuaweiCloud.REDIRECT_URI)) return false

        handled = true
        web.stopLoading()
        Log.d(TAG, "callback intercepted (${url.length} chars)")

        val uri = try {
            Uri.parse(url)
        } catch (e: Exception) {
            finishWith("Malformed callback: ${e.message}")
            return true
        }

        val error = uri.getQueryParameter("error")
        if (!error.isNullOrEmpty()) {
            // "access_denied" is the documented value when the user taps Cancel.
            finishWith(
                if (error == "access_denied") getString(R.string.hw_error_denied)
                else getString(R.string.hw_error_generic, error)
            )
            return true
        }

        val returnedState = uri.getQueryParameter("state")
        if (returnedState != state) {
            finishWith(getString(R.string.hw_error_state))
            return true
        }

        val code = uri.getQueryParameter("code")
        if (code.isNullOrEmpty()) {
            finishWith(getString(R.string.hw_error_no_code))
            return true
        }

        title.setText(R.string.hw_auth_exchanging)
        progress.visibility = View.VISIBLE
        web.visibility = View.GONE

        scope.launch {
            val failure = HuaweiCloud.exchangeCode(applicationContext, code)
            if (failure == null) {
                setResult(RESULT_OK)
                finish()
            } else {
                finishWith(failure)
            }
        }
        return true
    }

    private fun finishWith(error: String) {
        Toast.makeText(this, error, Toast.LENGTH_LONG).show()
        setResult(RESULT_CANCELED, android.content.Intent().putExtra(EXTRA_ERROR, error))
        finish()
    }

    // ------------------------------------------------------------------
    // Layout (built in code — one screen, no reusable pieces)
    // ------------------------------------------------------------------

    private fun buildLayout(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(NX_SHEET)
            fitsSystemWindows = true
        }

        title = TextView(this).apply {
            setText(R.string.hw_auth_title)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(14))
        }
        root.addView(
            title,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            indeterminateTintList = android.content.res.ColorStateList.valueOf(0xFF9c3dff.toInt())
        }
        root.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)))

        val frame = FrameLayout(this)
        web = WebView(this)
        frame.addView(
            web,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        root.addView(
            frame,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        )
        return root
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()
}
