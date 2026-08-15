package com.pulsenx.bridge.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
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
 * Edge-to-edge "aurora" backdrop: a near-black field with a handful of huge, very
 * soft radial blooms in the PulseNX palette that drift and breathe on slow,
 * mutually-prime loops so the motion never visibly repeats.
 *
 * Pure [Canvas] + one [ValueAnimator] - no Compose, no dependencies, nothing above
 * API 26. The animator only ever runs while the view is attached AND visible AND the
 * window is visible, so it cannot burn battery behind another activity. It also stays
 * off entirely when the user has disabled animations or turned on battery saver;
 * in that case a single static frame is drawn.
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
    private val matrix = Matrix()

    private val baseColor = context.getColor(R.color.aurora_base)

    private val blobs = arrayOf(
        // Violet anchor, top-left - the brand colour carries the composition.
        Blob(
            color = context.getColor(R.color.aurora_blob_violet),
            peakAlpha = 0.42f,
            baseX = 0.18f, baseY = 0.14f,
            driftX = 0.13f, driftY = 0.09f,
            radius = 0.82f, breath = 0.12f,
            driftPeriodMs = 27_000f, breathPeriodMs = 19_000f,
            phase = 0f
        ),
        // Cyan highlight, upper-right.
        Blob(
            color = context.getColor(R.color.aurora_blob_cyan),
            peakAlpha = 0.20f,
            baseX = 0.90f, baseY = 0.30f,
            driftX = 0.11f, driftY = 0.14f,
            radius = 0.55f, breath = 0.16f,
            driftPeriodMs = 34_000f, breathPeriodMs = 23_000f,
            phase = 1.7f
        ),
        // Heart red, low centre - sits behind the BPM card.
        Blob(
            color = context.getColor(R.color.aurora_blob_heart),
            peakAlpha = 0.17f,
            baseX = 0.62f, baseY = 0.78f,
            driftX = 0.16f, driftY = 0.08f,
            radius = 0.60f, breath = 0.14f,
            driftPeriodMs = 21_000f, breathPeriodMs = 31_000f,
            phase = 3.1f
        ),
        // Deep indigo wash, bottom-left - keeps the lower half from going flat black.
        Blob(
            color = context.getColor(R.color.aurora_blob_indigo),
            peakAlpha = 0.30f,
            baseX = 0.10f, baseY = 0.94f,
            driftX = 0.14f, driftY = 0.10f,
            radius = 0.78f, breath = 0.10f,
            driftPeriodMs = 39_000f, breathPeriodMs = 26_000f,
            phase = 4.4f
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

    /** Honour "remove animations" and battery saver: draw one static frame instead. */
    private fun animationsEnabled(): Boolean {
        val scale = try {
            Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f
            )
        } catch (_: Exception) {
            1f
        }
        if (scale == 0f) return false
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return power?.isPowerSaveMode != true
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        buildShaders()
        syncAnimation()
    }

    /**
     * Shaders are built once in unit space (centre 0,0 / radius 1) and re-aimed every
     * frame with a local matrix, so no allocation happens on the draw path.
     */
    private fun buildShaders() {
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
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(baseColor)

        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

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
