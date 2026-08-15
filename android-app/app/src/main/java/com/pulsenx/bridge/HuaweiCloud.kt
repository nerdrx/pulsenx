package com.pulsenx.bridge

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/**
 * Huawei Health Kit **cloud** account link: OAuth 2.0 credentials, token lifecycle and
 * the authenticated REST transport used by [HuaweiKitReader].
 *
 * Why a cloud integration at all: Huawei Health has no native Health Connect
 * integration on a GMS phone, so the watch's steps / sleep / SpO2 never reach the
 * on-device exchange layer. Huawei's Health Kit REST API is the only sanctioned way
 * to get at them, and it is pure HTTPS — no HMS Core, no HMS SDK, so this works on a
 * phone that has never seen a Huawei service framework.
 *
 * Everything below was read off the official docs (2026-08, doc pages last updated
 * 2026-07-27 / 2026-05-13) rather than guessed:
 *
 *  - OAuth authorize + token + refresh, parameter names, `access_type=offline`,
 *    `display=touch`, the `openid` scope requirement and the response JSON:
 *    https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/auth-example-0000001054581058
 *  - Result codes (401 = authentication failed, 403 = insufficient scopes / >100 beta users):
 *    https://developer.huawei.com/consumer/en/doc/HMSCore-References/error-code-0000001054236973
 *  - Request headers (`Authorization: Bearer <at>`, optional `x-client-id`, `x-version`,
 *    `x-caller-trace-id`) and the `health-api.cloud.huawei.com` host:
 *    https://developer.huawei.com/consumer/en/doc/HMSCore-References/sampleset_daily_polymerize-0000001078113560
 *
 * The refresh token is valid 180 days by default; the access token an hour.
 */
object HuaweiCloud {

    private const val TAG = "PulseNX/HuaweiCloud"

    // ==================================================================
    // Endpoints (verified, see the doc links on the object)
    // ==================================================================

    /** Browser-redirect endpoint that mints the authorization code. */
    const val AUTHORIZE_URL = "https://oauth-login.cloud.huawei.com/oauth2/v3/authorize"

    /** Token endpoint — serves both `authorization_code` and `refresh_token` grants. */
    const val TOKEN_URL = "https://oauth-login.cloud.huawei.com/oauth2/v3/token"

    /** Health Kit cloud REST host. All data paths hang off `/healthkit/v2/`. */
    const val API_BASE = "https://health-api.cloud.huawei.com"

    /**
     * Callback the WebView intercepts. It is never resolved by anything — the auth
     * activity kills the navigation the moment it sees this prefix — but it must be
     * registered byte-for-byte as the app's callback URL on HUAWEI Developers,
     * because the token exchange re-sends it and the server compares it verbatim.
     */
    const val REDIRECT_URI = "https://pulsenx.auth/callback"

    /**
     * Read scopes for everything the daily summary needs. `openid` is mandatory per
     * the auth doc. Every `healthkit` scope has to be applied for (and approved) on
     * the HUAWEI Developers console, or the API answers 403 rather than 401.
     *
     * Scope strings come from the individual cloud-side data-type pages:
     *   step.read              — .../HMSCore-Guides/steps-0000001177343435
     *   calories.read          — .../HMSCore-Guides/calories-0000001177343441
     *   distance.read          — .../HMSCore-Guides/distance-0000001131264000
     *   heartrate.read         — .../HMSCore-Guides/heart-rate-0000001131423780
     *   oxygensaturation.read  — .../HMSCore-Guides/blood-oxygen-0000001131264010
     *   sleep.read             — .../HMSCore-Guides/sleep-record-0000001177830493
     */
    val SCOPES: List<String> = listOf(
        "openid",
        "https://www.huawei.com/healthkit/step.read",
        "https://www.huawei.com/healthkit/distance.read",
        "https://www.huawei.com/healthkit/calories.read",
        "https://www.huawei.com/healthkit/heartrate.read",
        "https://www.huawei.com/healthkit/oxygensaturation.read",
        "https://www.huawei.com/healthkit/sleep.read"
    )

    // ==================================================================
    // Preference keys (all inside VitalsBridgeService.PREFS = "PulseNXPrefs")
    // ==================================================================

    const val KEY_CLIENT_ID = "HW_CLIENT_ID"
    const val KEY_CLIENT_SECRET = "HW_CLIENT_SECRET"
    const val KEY_ACCESS_TOKEN = "HW_ACCESS_TOKEN"
    const val KEY_REFRESH_TOKEN = "HW_REFRESH_TOKEN"

    /** Epoch ms at which the current access token stops being usable. */
    const val KEY_EXPIRES_AT = "HW_EXPIRES_AT"

    /** Scope string the server actually granted (may be narrower than [SCOPES]). */
    const val KEY_GRANTED_SCOPE = "HW_SCOPE"

    /** Epoch ms of the last successful cloud round-trip (link or data read). */
    const val KEY_LAST_OK_AT = "HW_LAST_OK_AT"

    /** Set when a refresh failed / a 401 survived a refresh: the user must relink. */
    const val KEY_AUTH_BROKEN = "HW_AUTH_BROKEN"

    /** Refresh this many ms before the server-stated expiry, to absorb clock skew. */
    private const val EXPIRY_SLACK_MS = 120_000L

    private val JSON = "application/json; charset=UTF-8".toMediaType()

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    /** Serialises token refreshes: five parallel metric reads must not mint five tokens. */
    private val tokenLock = Mutex()

    private val random = SecureRandom()

    // ==================================================================
    // Config store
    // ==================================================================

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(VitalsBridgeService.PREFS, Context.MODE_PRIVATE)

    fun clientId(context: Context): String = prefs(context).getString(KEY_CLIENT_ID, "").orEmpty().trim()

    fun clientSecret(context: Context): String =
        prefs(context).getString(KEY_CLIENT_SECRET, "").orEmpty().trim()

    fun saveCredentials(context: Context, clientId: String, clientSecret: String) {
        prefs(context).edit()
            .putString(KEY_CLIENT_ID, clientId.trim())
            .putString(KEY_CLIENT_SECRET, clientSecret.trim())
            .apply()
    }

    fun hasCredentials(context: Context): Boolean =
        clientId(context).isNotEmpty() && clientSecret(context).isNotEmpty()

    /** True once a refresh token exists — i.e. the Huawei account is linked. */
    fun isLinked(context: Context): Boolean =
        prefs(context).getString(KEY_REFRESH_TOKEN, "").orEmpty().isNotEmpty()

    fun isAuthBroken(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUTH_BROKEN, false)

    /** Epoch ms of the last successful cloud call, or 0. */
    fun lastOkAt(context: Context): Long = prefs(context).getLong(KEY_LAST_OK_AT, 0L)

    /** Drops the tokens but keeps the client id/secret — unlink, not "forget the app". */
    fun clear(context: Context) {
        prefs(context).edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_EXPIRES_AT)
            .remove(KEY_GRANTED_SCOPE)
            .remove(KEY_LAST_OK_AT)
            .remove(KEY_AUTH_BROKEN)
            .apply()
        Log.d(TAG, "Huawei cloud link cleared")
    }

    private fun markOk(context: Context) {
        prefs(context).edit()
            .putLong(KEY_LAST_OK_AT, System.currentTimeMillis())
            .putBoolean(KEY_AUTH_BROKEN, false)
            .apply()
    }

    private fun markBroken(context: Context, why: String) {
        Log.w(TAG, "auth broken: $why")
        prefs(context).edit().putBoolean(KEY_AUTH_BROKEN, true).apply()
    }

    // ==================================================================
    // Step 1 — authorization code
    // ==================================================================

    /** Random `state` for CSRF protection; echoed back on the callback unchanged. */
    fun newState(): String {
        val bytes = ByteArray(12)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * The URL the WebView loads.
     *
     * Built by hand rather than through `Uri.Builder` for one reason: the doc's own
     * example encodes the scope separator as `+`, which is what `URLEncoder` emits
     * and what `Uri.Builder` does *not* (it emits `%20`). Both are legal
     * form-encoding, but matching the documented example removes a variable from a
     * flow that cannot be tested without live credentials.
     */
    fun buildAuthorizeUrl(clientId: String, state: String): String {
        val scope = enc(SCOPES.joinToString(" "))
        return AUTHORIZE_URL +
            "?response_type=code" +
            "&client_id=" + enc(clientId) +
            "&redirect_uri=" + enc(REDIRECT_URI) +
            "&scope=" + scope +
            "&state=" + enc(state) +
            "&access_type=offline" +
            "&display=touch"
    }

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    // ==================================================================
    // Step 2 / 3 — token exchange and refresh
    // ==================================================================

    /**
     * Trades an authorization code for an access + refresh token pair.
     * Returns null on success, or a human-readable reason for the status line.
     */
    suspend fun exchangeCode(context: Context, code: String): String? = withContext(Dispatchers.IO) {
        val id = clientId(context)
        val secret = clientSecret(context)
        if (id.isEmpty() || secret.isEmpty()) return@withContext "Client ID / secret missing"

        val form = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("client_id", id)
            .add("client_secret", secret)
            .add("redirect_uri", REDIRECT_URI)
            .build()

        try {
            val (status, body) = post(TOKEN_URL, form)
            Log.d(TAG, "token exchange HTTP $status body=${redact(body)}")
            if (status != 200 || body == null) return@withContext tokenError(status, body)

            val json = JSONObject(body)
            val access = json.optString("access_token")
            val refresh = json.optString("refresh_token")
            if (access.isEmpty()) return@withContext tokenError(status, body)
            if (refresh.isEmpty()) {
                // Without access_type=offline (or when the console app is not allowed
                // an offline grant) there is no refresh token, and the link would die
                // in an hour with no way back. Treat it as a hard failure.
                return@withContext "Huawei returned no refresh token — check access_type=offline"
            }

            val expiresIn = json.optLong("expires_in", 3600L)
            prefs(context).edit()
                .putString(KEY_ACCESS_TOKEN, access)
                .putString(KEY_REFRESH_TOKEN, refresh)
                .putLong(KEY_EXPIRES_AT, System.currentTimeMillis() + expiresIn * 1000L)
                .putString(KEY_GRANTED_SCOPE, json.optString("scope"))
                .apply()
            markOk(context)
            Log.d(TAG, "linked, scope=${json.optString("scope")}, expires_in=$expiresIn")
            null
        } catch (e: Exception) {
            Log.w(TAG, "token exchange failed: ${e.message}")
            "Token exchange failed: ${e.message}"
        }
    }

    /**
     * Returns a usable access token, refreshing it when it is missing or (nearly)
     * expired. Single-flight: concurrent callers queue on [tokenLock] and the losers
     * find a fresh token already in prefs.
     *
     * @param force refresh even when the cached token still looks valid (used once
     *              after a 401, in case the server expired it early).
     */
    suspend fun refreshIfNeeded(context: Context, force: Boolean = false): String? =
        withContext(Dispatchers.IO) {
            tokenLock.withLock {
                val p = prefs(context)
                val cached = p.getString(KEY_ACCESS_TOKEN, "").orEmpty()
                val expiresAt = p.getLong(KEY_EXPIRES_AT, 0L)
                if (!force && cached.isNotEmpty() &&
                    System.currentTimeMillis() < expiresAt - EXPIRY_SLACK_MS
                ) {
                    return@withLock cached
                }

                val refresh = p.getString(KEY_REFRESH_TOKEN, "").orEmpty()
                val id = clientId(context)
                val secret = clientSecret(context)
                if (refresh.isEmpty() || id.isEmpty() || secret.isEmpty()) {
                    return@withLock null
                }

                val form = FormBody.Builder()
                    .add("grant_type", "refresh_token")
                    .add("refresh_token", refresh)
                    .add("client_id", id)
                    .add("client_secret", secret)
                    .build()

                try {
                    val (status, body) = post(TOKEN_URL, form)
                    Log.d(TAG, "token refresh HTTP $status body=${redact(body)}")
                    if (status != 200 || body == null) {
                        // 400 invalid_grant / 401: the refresh token is spent. Nothing
                        // the app can do but ask for a fresh consent.
                        markBroken(context, "refresh HTTP $status")
                        return@withLock null
                    }
                    val json = JSONObject(body)
                    val access = json.optString("access_token")
                    if (access.isEmpty()) {
                        markBroken(context, "refresh returned no access_token")
                        return@withLock null
                    }
                    val expiresIn = json.optLong("expires_in", 3600L)
                    p.edit()
                        .putString(KEY_ACCESS_TOKEN, access)
                        .putLong(KEY_EXPIRES_AT, System.currentTimeMillis() + expiresIn * 1000L)
                        .apply()
                    // The refresh grant does not re-issue a refresh token; the old one
                    // stays valid for its 180-day window.
                    markOk(context)
                    access
                } catch (e: Exception) {
                    // A transient network error must NOT be mistaken for a dead grant.
                    Log.w(TAG, "token refresh failed (transient?): ${e.message}")
                    null
                }
            }
        }

    /**
     * Unauthenticated `application/x-www-form-urlencoded` POST — the OAuth token
     * endpoint is the only thing that speaks it, and it authenticates with the
     * client secret in the body rather than a bearer header.
     */
    private fun post(url: String, form: FormBody): Pair<Int, String?> =
        http.newCall(Request.Builder().url(url).post(form).build()).execute().use { response ->
            response.code to response.body?.string()
        }

    private fun tokenError(status: Int, body: String?): String {
        val detail = try {
            body?.let { JSONObject(it) }?.let {
                it.optString("sub_error", it.optString("error_description", it.optString("error")))
            }
        } catch (_: Exception) {
            null
        }
        return "Huawei rejected the sign-in (HTTP $status${if (detail.isNullOrEmpty()) "" else ", $detail"})"
    }

    // ==================================================================
    // Authenticated REST transport
    // ==================================================================

    /** HTTP status plus raw body; [body] is null only when the call blew up. */
    data class ApiResult(val status: Int, val body: String?) {
        val ok: Boolean get() = status in 200..299
    }

    suspend fun apiGet(context: Context, url: String): ApiResult =
        withContext(Dispatchers.IO) { call(context, url, null) }

    suspend fun apiPost(context: Context, url: String, json: JSONObject): ApiResult =
        withContext(Dispatchers.IO) { call(context, url, json) }

    /**
     * One authenticated call, with exactly one transparent retry: on 401 the token is
     * force-refreshed and the request replayed. A 401 that survives that means the
     * grant is gone, so the link is flagged broken for the status line.
     */
    private suspend fun call(context: Context, url: String, json: JSONObject?): ApiResult {
        // A null token here is either "no grant" (refreshIfNeeded already flagged it)
        // or a transient network failure during the refresh. Neither is diagnosed
        // *here*: flagging the link broken on a dropped Wi-Fi packet would tell the
        // user to re-consent for nothing.
        var token = refreshIfNeeded(context) ?: return ApiResult(401, null)

        var result = execute(context, url, json, token)
        if (result.status == 401) {
            Log.d(TAG, "401 on $url, forcing a token refresh")
            token = refreshIfNeeded(context, force = true) ?: return result
            result = execute(context, url, json, token)
            // A 401 that survives a *successful* refresh is the definitive signal:
            // the grant itself is gone, and only a fresh consent can fix it.
            if (result.status == 401) markBroken(context, "401 survived a refresh")
        }
        if (result.ok) markOk(context)
        return result
    }

    private fun execute(
        context: Context,
        url: String,
        json: JSONObject?,
        token: String
    ): ApiResult = try {
        val builder = Request.Builder()
            .url(url)
            // "A space character must be added between Bearer and the value of access_token."
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json; charset=UTF-8")
            // Optional but recommended by the docs; lets Huawei route/trace the call.
            .header("x-client-id", clientId(context))
            .header("x-version", "1.0")

        if (json != null) {
            builder.post(json.toString().toRequestBody(JSON))
        } else {
            builder.get()
        }

        http.newCall(builder.build()).execute().use { response ->
            val body = response.body?.string()
            Log.d(
                TAG,
                "${if (json == null) "GET" else "POST"} $url -> ${response.code} " +
                    "privacy=${response.header("x-health-app-privacy")} body=${clip(body)}"
            )
            ApiResult(response.code, body)
        }
    } catch (e: Exception) {
        Log.w(TAG, "request to $url failed: ${e.message}")
        ApiResult(-1, null)
    }

    // ==================================================================
    // Logging helpers
    // ==================================================================

    /** Token bodies are secrets; log only their shape. */
    private fun redact(body: String?): String {
        if (body == null) return "<null>"
        return try {
            val json = JSONObject(body)
            val keys = json.keys().asSequence().toList().sorted()
            "{keys=$keys, expires_in=${json.optLong("expires_in", -1)}}"
        } catch (_: Exception) {
            "<${body.length} chars>"
        }
    }

    /** Data bodies are not secret but can be long; keep logcat readable. */
    private fun clip(body: String?): String = when {
        body == null -> "<null>"
        body.length <= 1200 -> body
        else -> body.take(1200) + "…(${body.length} chars)"
    }
}
