package com.pulsenx.bridge.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import com.pulsenx.bridge.R
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.sin

/**
 * The living background of NX Design Language §3: a deep-space field
 * (`--bg-top → --bg-bottom`, never flat black) carrying two enormous, very
 * low-alpha nebula blooms - violet biased upper-left, cyan lower-right - plus an
 * optional deep magenta third, drifting on slow mutually-prime loops so the motion
 * never visibly repeats. A soft vignette keeps the edges darker than the centre.
 *
 * Drift periods sit in the spec's 60-110 s band; nothing here reads as movement
 * when you look straight at it, which is the point.
 *
 * Pure [Canvas] + one [ValueAnimator] - no Compose, no dependencies, nothing above
 * API 26. The animator only ever runs while the view is attached AND visible AND the
 * window is visible, so it cannot burn battery behind another activity. It also stays
 * off entirely under the system reduced-motion settings or battery saver; in that
 * case a single static frame is drawn (§6: reduced motion is non-negotiable).
 */
class AuroraBackgroundView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    /**
     * One bloom. Positions/radii are fractions of the view box so the composition
     * survives any screen size or rotation.
     */
    private class Blob(
        val color: Int,
        val peakAlpha: Float,
        val baseX: Float,
        val baseY: Float,
        val driftX: Float,
        val driftY: Float,
        val radius: Float,
        val breath: Float,
        val driftPeriodMs: Float,
        val breathPeriodMs: Float,
        val phase: Float
    ) {
        var shader: RadialGradient? = null
    }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
    private val fieldPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
    private val vignettePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
    private val matrix = Matrix()

    private val fieldTop = context.getColor(R.color.nx_bg_top)
    private val fieldBottom = context.getColor(R.color.nx_bg_bottom)
    private val vignetteColor = context.getColor(R.color.aurora_vignette)

    private val blobs = arrayOf(
        // Violet anchor, upper-left - the brand colour carries the composition.
        Blob(
            color = context.getColor(R.color.aurora_blob_violet),
            peakAlpha = 0.28f,
            baseX = 0.16f, baseY = 0.13f,
            driftX = 0.10f, driftY = 0.07f,
            radius = 0.88f, breath = 0.10f,
            driftPeriodMs = 67_000f, breathPeriodMs = 89_000f,
            phase = 0f
        ),
        // Cyan light source, lower-right - subordinate to the violet, never a surface.
        Blob(
            color = context.getColor(R.color.aurora_blob_cyan),
            peakAlpha = 0.13f,
            baseX = 0.88f, baseY = 0.80f,
            driftX = 0.09f, driftY = 0.11f,
            radius = 0.62f, breath = 0.13f,
            driftPeriodMs = 83_000f, breathPeriodMs = 71_000f,
            phase = 1.7f
        ),
        // Optional deep magenta third, low-left, keeping the bottom from going flat.
        Blob(
            color = context.getColor(R.color.aurora_blob_magenta),
            peakAlpha = 0.10f,
            baseX = 0.22f, baseY = 0.88f,
            driftX = 0.12f, driftY = 0.08f,
            radius = 0.70f, breath = 0.12f,
            driftPeriodMs = 103_000f, breathPeriodMs = 97_000f,
            phase = 3.1f
        )
    )

    private var startMs = SystemClock.elapsedRealtime()
    private var lastFrameMs = 0L
    private var pausedOffsetMs = 0L
    private var animationAllowed = true

    /** View can dispatch onVisibilityChanged from its own constructor; ignore those. */
    private var constructed = false

    /** Ticker only: the actual phase comes from the wall clock, so periods stay independent. */
    private val ticker = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = FRAME_LOOP_MS
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            val now = SystemClock.elapsedRealtime()
            if (now - lastFrameMs >= MIN_FRAME_INTERVAL_MS) {
                lastFrameMs = now
                invalidate()
            }
        }
    }

    init {
        // Nothing here is interactive; keep it out of the touch and a11y trees.
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        constructed = true
    }

    // ------------------------------------------------------------------
    // Lifecycle - the animator must never outlive visibility
    // ------------------------------------------------------------------

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // Re-read every time we come back: the user can flip either setting while the
        // activity sits in the background.
        animationAllowed = animationsEnabled()
        syncAnimation()
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        syncAnimation()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility == VISIBLE) animationAllowed = animationsEnabled()
        syncAnimation()
    }

    private fun syncAnimation() {
        if (!constructed) return
        val shouldRun = animationAllowed &&
            isAttachedToWindow &&
            visibility == VISIBLE &&
            windowVisibility == VISIBLE &&
            width > 0 && height > 0 &&
            !isInEditMode
        if (shouldRun) start() else stop()
    }

    private fun start() {
        if (ticker.isStarted) return
        startMs = SystemClock.elapsedRealtime() - pausedOffsetMs
        ticker.start()
    }

    private fun stop() {
        if (!ticker.isStarted) return
        pausedOffsetMs = SystemClock.elapsedRealtime() - startMs
        ticker.cancel()
    }

    /**
     * Honour reduced motion and battery saver: draw one static frame instead.
     *
     * Android has no `prefers-reduced-motion`; the closest equivalents are the two
     * developer/accessibility animation scales, both of which the "remove animations"
     * accessibility shortcut zeroes. Either one at 0 means the user asked for stillness.
     */
    private fun animationsEnabled(): Boolean {
        if (globalScale(Settings.Global.ANIMATOR_DURATION_SCALE) == 0f) return false
        if (globalScale(Settings.Global.TRANSITION_ANIMATION_SCALE) == 0f) return false
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return power?.isPowerSaveMode != true
    }

    private fun globalScale(key: String): Float = try {
        Settings.Global.getFloat(context.contentResolver, key, 1f)
    } catch (_: Exception) {
        1f
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        buildShaders(w.toFloat(), h.toFloat())
        syncAnimation()
    }

    /**
     * Blob shaders are built once in unit space (centre 0,0 / radius 1) and re-aimed
     * every frame with a local matrix, so no allocation happens on the draw path.
     * The field and vignette depend only on the view box, so they are built here too.
     */
    private fun buildShaders(w: Float, h: Float) {
        for (blob in blobs) {
            val core = withAlpha(blob.color, blob.peakAlpha)
            val mid = withAlpha(blob.color, blob.peakAlpha * 0.45f)
            val edge = withAlpha(blob.color, 0f)
            blob.shader = RadialGradient(
                0f, 0f, 1f,
                intArrayOf(core, mid, edge),
                floatArrayOf(0f, 0.42f, 1f),
                Shader.TileMode.CLAMP
            )
        }

        if (w <= 0f || h <= 0f) return

        fieldPaint.shader = LinearGradient(
            0f, 0f, 0f, h,
            fieldTop, fieldBottom,
            Shader.TileMode.CLAMP
        )

        // Vignette: transparent through the middle, deepening to the corners so the
        // nebula never runs flat off the edges of the screen.
        vignettePaint.shader = RadialGradient(
            w * 0.5f, h * 0.44f, max(w, h) * 0.78f,
            intArrayOf(
                withAlpha(vignetteColor, 0f),
                withAlpha(vignetteColor, 0f),
                vignetteColor
            ),
            floatArrayOf(0f, 0.55f, 1f),
            Shader.TileMode.CLAMP
        )
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        // Field first: --bg-top → --bg-bottom, so nothing is ever painted on black.
        canvas.drawRect(0f, 0f, w, h, fieldPaint)

        val span = max(w, h)
        val t = if (isInEditMode || !ticker.isStarted) pausedOffsetMs.toFloat()
        else (SystemClock.elapsedRealtime() - startMs).toFloat()

        for (blob in blobs) {
            val shader = blob.shader ?: continue

            val driftAngle = TAU * (t / blob.driftPeriodMs) + blob.phase
            val breathAngle = TAU * (t / blob.breathPeriodMs) + blob.phase

            val cx = blob.baseX * w + blob.driftX * w * sin(driftAngle)
            // Quarter-turn offset on Y turns the drift into a slow ellipse, not a line.
            val cy = blob.baseY * h + blob.driftY * h * sin(driftAngle + HALF_PI)
            val r = blob.radius * span * (1f + blob.breath * sin(breathAngle))

            matrix.setScale(r, r)
            matrix.postTranslate(cx, cy)
            shader.setLocalMatrix(matrix)

            paint.shader = shader
            canvas.drawCircle(cx, cy, r, paint)
        }
        paint.shader = null

        canvas.drawRect(0f, 0f, w, h, vignettePaint)
    }

    private fun withAlpha(color: Int, alpha: Float): Int {
        val a = (alpha.coerceIn(0f, 1f) * 255f).toInt()
        return (color and 0x00FFFFFF) or (a shl 24)
    }

    private companion object {
        const val TAU = (2.0 * PI).toFloat()
        const val HALF_PI = (PI / 2.0).toFloat()

        /** Ticker loop length; irrelevant to the visuals, it only paces invalidations. */
        const val FRAME_LOOP_MS = 10_000L

        /** ~30 fps is plenty for gradients this soft, and halves the redraw cost. */
        const val MIN_FRAME_INTERVAL_MS = 32L
    }
}
