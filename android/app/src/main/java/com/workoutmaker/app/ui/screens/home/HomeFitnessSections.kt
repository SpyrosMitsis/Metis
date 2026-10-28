package com.workoutmaker.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import com.workoutmaker.app.ui.components.chartLabel
import com.workoutmaker.app.ui.components.fillUnderLine
import com.workoutmaker.app.ui.components.hGridLine
import com.workoutmaker.app.ui.components.InfoIcon
import com.workoutmaker.app.ui.components.Metrics
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SectionLabel
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import com.workoutmaker.app.data.FitnessPoint
import com.workoutmaker.app.data.FitnessSummary
import com.workoutmaker.app.data.IntervalsActivity
import com.workoutmaker.app.data.IntervalsStats
import com.workoutmaker.app.util.friendlyError
import com.workoutmaker.app.ui.theme.amberAccent

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun FitnessSection(
    modifier: Modifier,
    f: IntervalsStats,
    onOpenActivity: (IntervalsActivity) -> Unit = {},
) {
    if (!f.connected) {
        SectionCard(modifier, title = "Fitness (Intervals.icu)") {
            Text("Connect Intervals.icu in Settings to see your fitness curve, HR zones and recent activities here.",
                style = MaterialTheme.typography.bodyMedium)
        }
        return
    }
    if (f.error != null) {
        SectionCard(modifier, title = "Fitness (Intervals.icu)") {
            Text(friendlyError(f.error), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error)
        }
        return
    }

    SectionCard(modifier, title = "Fitness" + (f.athlete_name?.let { " · $it" } ?: "")) {
        f.summary?.let { s ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.SpaceBetween) {
                    FitnessStat("Fitness", "%.0f".format(s.ctl), "CTL", MaterialTheme.colorScheme.primary)
                    FitnessStat("Fatigue", "%.0f".format(s.atl), "ATL", MaterialTheme.colorScheme.secondary)
                    FitnessStat("Form", "%+.0f".format(s.tsb), tsbLabel(s.tsb), tsbColor(s.tsb))
                    FitnessStat("Ramp", "%+.1f".format(s.ramp), "7d CTL", MaterialTheme.colorScheme.onSurfaceVariant)
                }
                InfoIcon("Your fitness curve", Metrics.FITNESS)
            }
        }
        // E3: load guardrail derived from fatigue:fitness ratio + CTL ramp.
        f.summary?.let { s -> LoadGuard(s) }
        if (f.fitness.size >= 2) {
            FitnessChart(f.fitness, Modifier.fillMaxWidth().padding(top = 4.dp))
            val latest = f.fitness.last()
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                LegendDot("Fitness (CTL) ${"%.0f".format(latest.ctl)}", MaterialTheme.colorScheme.primary)
                LegendDot("Fatigue (ATL) ${"%.0f".format(latest.atl)}", MaterialTheme.colorScheme.secondary)
            }

            // Form (TSB) over time on the Intervals.icu zone backdrop.
            SectionLabel("Form (TSB) · now ${"%+.0f".format(latest.tsb)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            FormChart(f.fitness, Modifier.fillMaxWidth())
            SectionLabel("Tap a point for its date & value", color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FORM_ZONES.forEach { z -> LegendDot(z.label, z.color) }
            }
        }
    }

    // Heart-rate zones intentionally omitted from Home — they're reference data,
    // not an at-a-glance dashboard signal. (Still available in Intervals.icu.)

    if (f.activities.isNotEmpty()) {
        SectionCard(modifier, title = "Recent activities") {
            f.activities.take(8).forEach { a ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenActivity(a) }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("${a.date} · ${a.name}", style = MaterialTheme.typography.labelMedium)
                        val meta = buildString {
                            a.distance_km?.let { append("%.1f km".format(it)) }
                            a.duration_min?.let { if (isNotEmpty()) append(" · "); append("${it} min") }
                            a.avg_hr?.let { if (isNotEmpty()) append(" · "); append("${it} bpm") }
                            a.tss?.let { if (isNotEmpty()) append(" · "); append("${it.toInt()} TSS") }
                        }
                        if (meta.isNotBlank()) {
                            Text(meta, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = "Open details",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

// E3 — acute:chronic load guardrail. Uses the fatigue:fitness ratio (ATL/CTL),
// A description of recorded load and its recent trend; not an injury prediction.
@Composable
private fun LoadGuard(s: FitnessSummary) {
    if (s.ctl < 1.0) return // not enough data to judge
    val ratio = s.atl / s.ctl
    val (color, headline, detail) = when {
        ratio >= 1.5 -> Triple(
            amberAccent(), "Recent recorded load is higher",
            "ATL/CTL ratio %.2f describes modeled load, not individual injury risk. Review actual training and how you feel.".format(ratio))
        ratio >= 1.3 || s.ramp >= 8 -> Triple(
            amberAccent(), "Recorded load is increasing",
            "Ratio %.2f, ramp %+.1f. Interpret this with your actual training and response, not as a readiness verdict.".format(ratio, s.ramp))
        ratio < 0.8 && s.ramp < 0 -> Triple(
            amberAccent(), "Recent recorded load is lower",
            "Ratio %.2f may reflect rest, changed plans or missing recordings. Do not add work just to raise the ratio.".format(ratio))
        else -> Triple(
            MaterialTheme.colorScheme.primary, "Recorded load context",
            "ATL/CTL ratio %.2f is descriptive. It does not establish training quality or recovery.".format(ratio))
    }
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp)
            .background(color.copy(alpha = 0.15f), RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Column(Modifier.padding(start = 10.dp)) {
            Text(headline, style = MaterialTheme.typography.titleSmall, color = color)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun FitnessStat(label: String, value: String, sub: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.titleLarge, color = color)
        Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun LegendDot(label: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Text("  $label", style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun tsbColor(tsb: Double): Color = when {
    tsb > 5 -> MaterialTheme.colorScheme.primary
    tsb < -20 -> MaterialTheme.colorScheme.error
    tsb < -10 -> amberAccent()
    else -> MaterialTheme.colorScheme.primary
}

private fun tsbLabel(tsb: Double): String = when {
    tsb > 15 -> "fresh"
    tsb > 5 -> "ready"
    tsb < -20 -> "high fatigue"
    tsb < -10 -> "building"
    else -> "neutral"
}

// Intervals.icu "Form" (TSB) zones, top→bottom. Each is (lower bound, label,
// colour); a band fills from its bound up to the next one.
private data class FormZone(val min: Double, val label: String, val color: Color)

// Vivid fixed zone hues (matching the ChartHr/Pace/Power palette) so the Form
// backdrop and its legend dots read boldly across every theme.
private val FORM_ZONES = listOf(
    FormZone(25.0, "Transition", Color(0xFFFF9F0A)),  // amber
    FormZone(5.0, "Fresh", Color(0xFF0A84FF)),        // blue
    FormZone(-10.0, "Grey zone", Color(0xFF8E8E93)),  // grey
    FormZone(-30.0, "Optimal", Color(0xFF30D158)),    // green
    FormZone(-100.0, "High risk", Color(0xFFFF453A)), // red
)

// Form chart: the TSB line over time on a fixed zone backdrop (mirrors the
// bottom panel of Intervals.icu's fitness page). Bands are translucent so the
// line reads clearly on top.
@Composable
private fun FormChart(points: List<FitnessPoint>, modifier: Modifier) {
    val grid = MaterialTheme.colorScheme.surfaceVariant
    val marker = MaterialTheme.colorScheme.onSurface
    val last = points.last()
    // Tap a point to pin its date + TSB; tap it again (or another) to move/clear.
    var selected by remember(points) { mutableStateOf<Int?>(null) }
    val gutterDp = 30.dp
    Canvas(
        modifier
            .size(width = 0.dp, height = 130.dp)
            .fillMaxWidth()
            .pointerInput(points) {
                val gl = gutterDp.toPx()
                val plotW = (size.width - gl).coerceAtLeast(1f)
                val step = if (points.size > 1) plotW / (points.size - 1) else plotW
                detectTapGestures { off ->
                    val idx = ((off.x - gl) / step).roundToInt().coerceIn(0, points.size - 1)
                    selected = if (selected == idx) null else idx
                }
            },
    ) {
        val dataMax = points.maxOf { it.tsb }
        val dataMin = points.minOf { it.tsb }
        val top = maxOf(30.0, dataMax + 4)
        val bottom = minOf(-40.0, dataMin - 4)
        val span = (top - bottom).coerceAtLeast(1.0)
        val w = size.width
        val gutterLeft = 30.dp.toPx()
        val labelPad = 14.sp.toPx()
        val h = size.height - labelPad
        val plotW = (w - gutterLeft).coerceAtLeast(1f)
        fun y(v: Double) = (h * (top - v) / span).toFloat().coerceIn(0f, h)
        val stepX = if (points.size > 1) plotW / (points.size - 1) else plotW
        fun x(i: Int) = gutterLeft + stepX * i

        // Zone bands: each fills from the zone above (or the top) down to its min.
        FORM_ZONES.forEachIndexed { i, z ->
            val upper = if (i == 0) top else FORM_ZONES[i - 1].min
            val yU = y(upper.coerceIn(bottom, top))
            val yL = y(z.min.coerceIn(bottom, top))
            if (yL > yU) {
                drawRect(
                    z.color.copy(alpha = 0.30f),
                    topLeft = Offset(gutterLeft, yU),
                    size = Size(plotW, yL - yU),
                )
            }
        }
        // Zero baseline + axis numbers (in the left gutter).
        drawLine(grid, Offset(gutterLeft, y(0.0)), Offset(w, y(0.0)), strokeWidth = 2f)
        chartLabel("${top.toInt()}", gutterLeft - 6f, y(top) + 9.sp.toPx() * 0.6f, alignRight = true)
        chartLabel("0", gutterLeft - 6f, y(0.0) - 3f, alignRight = true)
        chartLabel("${bottom.toInt()}", gutterLeft - 6f, h - 2f, alignRight = true)
        chartLabel(points.first().date.takeLast(5), gutterLeft, size.height - 2f)
        chartLabel(last.date.takeLast(5), w, size.height - 2f, alignRight = true)

        // TSB line, coloured by the zone each part falls in — the stretch inside
        // the green band is green, inside red is red, and so on. Each segment is
        // split exactly at the zone boundaries it crosses so the colour flips on
        // the band edge rather than at a data point.
        fun zoneColorOf(v: Double): Color =
            FORM_ZONES.firstOrNull { v >= it.min }?.color ?: FORM_ZONES.last().color
        val boundaries = FORM_ZONES.dropLast(1).map { it.min } // 25, 5, -10, -30
        for (i in 0 until points.size - 1) {
            val v0 = points[i].tsb
            val v1 = points[i + 1].tsb
            val x0 = x(i)
            val x1 = x(i + 1)
            // Fractions (0..1) along this segment where it crosses a zone edge.
            val cuts = boundaries.mapNotNull { b ->
                if ((v0 < b && v1 > b) || (v0 > b && v1 < b)) (b - v0) / (v1 - v0) else null
            }.sorted()
            val ts = listOf(0.0) + cuts + listOf(1.0)
            for (k in 0 until ts.size - 1) {
                val ta = ts[k]
                val tb = ts[k + 1]
                if (tb <= ta) continue
                val mid = v0 + (v1 - v0) * (ta + tb) / 2
                drawLine(
                    zoneColorOf(mid),
                    Offset((x0 + (x1 - x0) * ta).toFloat(), y(v0 + (v1 - v0) * ta)),
                    Offset((x0 + (x1 - x0) * tb).toFloat(), y(v0 + (v1 - v0) * tb)),
                    strokeWidth = 3.5f,
                    cap = StrokeCap.Round,
                )
            }
        }

        // Pinned point: a vertical guide, a dot, and a "MM-DD · +5" callout. Drawn
        // last so it sits on top of the bands and the line.
        selected?.let { sel ->
            val p = points[sel]
            val px = x(sel)
            val py = y(p.tsb)
            drawLine(marker.copy(alpha = 0.4f), Offset(px, 0f), Offset(px, h), strokeWidth = 1.5f)
            drawCircle(marker, radius = 4f, center = Offset(px, py))
            val txt = "${p.date.takeLast(5)} · ${"%+.0f".format(p.tsb)}"
            val nearRight = px > size.width * 0.6f
            chartLabel(txt, if (nearRight) px - 6f else px + 6f, (y(top) + 9.sp.toPx()).coerceAtLeast(11.sp.toPx()), alignRight = nearRight, color = marker)
        }
    }
}

@Composable
private fun FitnessChart(points: List<FitnessPoint>, modifier: Modifier) {
    val ctlColor = MaterialTheme.colorScheme.primary
    val atlColor = MaterialTheme.colorScheme.secondary
    val grid = MaterialTheme.colorScheme.surfaceVariant
    val last = points.last()
    Canvas(modifier.size(width = 0.dp, height = 150.dp).fillMaxWidth()) {
        val maxV = (points.maxOf { maxOf(it.ctl, it.atl) }).coerceAtLeast(1.0)
        val w = size.width
        val gutterLeft = 34.dp.toPx() // room for the value axis on the left
        val labelPad = 14.sp.toPx()   // room for the date axis at the bottom
        val h = size.height - labelPad
        val plotW = (w - gutterLeft).coerceAtLeast(1f)
        val stepX = if (points.size > 1) plotW / (points.size - 1) else plotW
        fun x(i: Int) = gutterLeft + stepX * i
        fun y(v: Double) = h - (v / maxV * h).toFloat()

        // Value scale: gridlines + numbers at max / half / 0 (TSS/day load).
        hGridLine(y(maxV), gutterLeft, w)
        hGridLine(y(maxV / 2), gutterLeft, w)
        drawLine(grid, Offset(gutterLeft, h), Offset(w, h), strokeWidth = 2f)
        chartLabel("${maxV.toInt()}", gutterLeft - 6f, y(maxV) + 9.sp.toPx() * 0.5f, alignRight = true)
        chartLabel("${(maxV / 2).toInt()}", gutterLeft - 6f, y(maxV / 2) + 9.sp.toPx() * 0.35f, alignRight = true)
        chartLabel("0", gutterLeft - 6f, h - 2f, alignRight = true)
        // Date range on the x axis (MM-DD).
        chartLabel(points.first().date.takeLast(5), gutterLeft, size.height - 2f)
        chartLabel(last.date.takeLast(5), w, size.height - 2f, alignRight = true)

        fun line(sel: (FitnessPoint) -> Double, color: Color) {
            val path = Path()
            points.forEachIndexed { i, p ->
                val px = x(i)
                val py = y(sel(p))
                if (i == 0) path.moveTo(px, py) else path.lineTo(px, py)
            }
            fillUnderLine(path, color, h, 0f, x(0), x(points.size - 1))
            drawPath(
                path, color,
                style = Stroke(
                    width = 3.5f,
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                ),
            )
        }
        line({ it.atl }, atlColor)
        line({ it.ctl }, ctlColor)
    }
}
