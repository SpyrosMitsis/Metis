package com.workoutmaker.app.ui.screens.home

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import com.workoutmaker.app.ui.components.InsetStat
import com.workoutmaker.app.ui.components.SectionCard
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import com.workoutmaker.app.data.InjuryBackoff
import com.workoutmaker.app.data.InjuryCheckin
import com.workoutmaker.app.data.RecoveryDriver
import com.workoutmaker.app.data.RecoveryTrend
import com.workoutmaker.app.ui.theme.amberAccent
import java.time.LocalDate
import java.time.format.DateTimeFormatter

// Morning wellness check-in: two 1–5 scales (energy, soreness) that feed today's
// readiness score. Sleep is pulled automatically from Intervals.icu, so it's no
// longer asked here. Appears only when today is unanswered.
@Composable
internal fun WellnessCheckinCard(modifier: Modifier, busy: Boolean, onSave: (Int, Int) -> Unit) {
    var energy by rememberSaveable { mutableStateOf<Int?>(null) }
    var soreness by rememberSaveable { mutableStateOf<Int?>(null) }
    SectionCard(modifier, title = "How do you feel today?") {
        Text(
            "A quick morning check tunes today's readiness and training. Sleep is pulled from Intervals.icu automatically.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        WellnessScale("Energy", "drained", "fresh", energy) { energy = it }
        WellnessScale("Soreness", "none", "very sore", soreness) { soreness = it }
        Button(
            onClick = { onSave(energy ?: 3, soreness ?: 3) },
            enabled = !busy && (energy != null || soreness != null),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Saving…" else "Save check-in") }
    }
}

// One 1-5 row: label, low/high anchor words, and five tap targets. Internal
// because the post-workout pain check reuses it verbatim: the athlete should
// only ever have to learn one scale, and a second one drawn differently would
// make 3 mean something different depending on which card asked.
@Composable
internal fun WellnessScale(label: String, low: String, high: String, selected: Int?, onSelect: (Int) -> Unit) {
    val haptics = LocalHapticFeedback.current
    Column(Modifier.padding(top = 8.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            (1..5).forEach { n ->
                val active = selected == n
                val bg by animateColorAsState(
                    if (active) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.surfaceContainerHigh,
                    label = "wellnessTile",
                )
                Box(
                    Modifier
                        .weight(1f)
                        .size(width = 0.dp, height = 48.dp)
                        .background(bg, RoundedCornerShape(8.dp))
                        .clickable(onClickLabel = "Set $label to $n of 5") {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onSelect(n)
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "$n",
                        color = if (active) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                        fontSize = 15.sp,
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(low, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(high, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// ---------------------------------------------------------------------------
// The injury follow-up loop
// ---------------------------------------------------------------------------

// "Is your knee still bothering you?", a few days after they raised it and then
// weekly while it lasts. Three answers, one tap, no free text: the whole point
// is that it costs nothing to close, because a question that costs something to
// answer stops being answered.
//
// The question itself is composed server-side (followUpQuestion in
// _shared/injury.ts) so the coach and the card word it the same way.
@Composable
internal fun InjuryCheckinCard(
    modifier: Modifier,
    checkin: InjuryCheckin,
    busy: Boolean,
    onAnswer: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    SectionCard(modifier, title = checkin.question) {
        Text(
            "It changes what I program. Nothing else, no follow-up questions.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                "present" to "Still there",
                "better" to "Better",
                "resolved" to "All good",
            ).forEach { (status, label) ->
                Button(
                    onClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        onAnswer(status)
                    },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                ) { Text(label, style = MaterialTheme.typography.labelSmall) }
            }
        }
    }
}

// What the engine is currently doing about a reported pain, in the athlete's
// words. Amber, not red: something to work around, not an emergency (the
// palette note in CLAUDE.md). Shown because training that quietly changes shape
// is worse than training that says why it changed.
@Composable
internal fun InjuryBackoffBanner(modifier: Modifier, backoffs: List<InjuryBackoff>) {
    if (backoffs.isEmpty()) return
    val amber = amberAccent()
    SectionCard(modifier) {
        backoffs.forEach { b ->
            Text(
                backoffLine(b),
                style = MaterialTheme.typography.bodyMedium,
                color = amber,
            )
        }
        Text(
            "It lifts on its own. Tell me sooner if it settles.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** One backoff, said out loud. Kept pure so the wording is unit-testable. */
internal fun backoffLine(b: InjuryBackoff): String {
    val area = b.area.trim().lowercase()
    val until = runCatching {
        LocalDate.parse(b.until).format(DateTimeFormatter.ofPattern("d MMM"))
    }.getOrDefault(b.until)
    return if (b.level == "avoid") {
        "Keeping the load off your $area until $until."
    } else {
        "Going easy on your $area until $until."
    }
}

// Device sleep score (0..100) → short word + readiness band colour.
internal fun sleepScoreLabel(score: Double): String = when {
    score >= 85 -> "excellent"
    score >= 70 -> "good"
    score >= 50 -> "fair"
    else -> "poor"
}

internal fun sleepScoreBand(score: Double): String = when {
    score >= 70 -> "green"
    score >= 50 -> "amber"
    else -> "red"
}

// A uniform metric row: a full-width inset field + a fixed 48dp trailing slot
// (trend badge, info ⓘ, or empty) so every field box is exactly the same length.
@Composable
internal fun MetricRow(label: String, value: String, trailing: @Composable () -> Unit = {}) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        InsetStat(label, value, Modifier.weight(1f))
        Box(Modifier.width(48.dp), contentAlignment = Alignment.Center) { trailing() }
    }
}

// Loud banner when the watch hasn't reported in a while — the readiness read is
// then running blind on objective signals, so it shouldn't look business-as-usual.
@Composable
internal fun RecoveryStaleBanner(syncedDate: String?) {
    val color = amberAccent()
    val msg = if (syncedDate == null) {
        "No recovery data has synced yet. Pull down to sync your watch."
    } else {
        "Watch hasn't synced since ${friendlyDate(syncedDate)}, today's HRV, resting HR " +
            "and sleep may be missing. Pull down to refresh."
    }
    Row(
        Modifier.fillMaxWidth()
            .background(color.copy(alpha = 0.15f), RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Text(
            msg,
            Modifier.padding(start = 10.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// One readiness driver as a tinted pill ("HRV ↑", "Sleep ↓"); colour = tone.
@Composable
internal fun RecoveryDriverChip(d: RecoveryDriver) {
    val color = when (d.tone) {
        "good" -> MaterialTheme.colorScheme.primary
        "bad" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val arrow = when (d.dir) { "up" -> "↑"; "down" -> "↓"; else -> "→" }
    Box(
        Modifier
            .background(color.copy(alpha = 0.13f), RoundedCornerShape(8.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text("${d.label} $arrow", style = MaterialTheme.typography.labelMedium, color = color)
    }
}

// "2026-06-28" → "28 Jun"; falls back to the raw string if unparseable.
internal fun friendlyDate(iso: String): String =
    runCatching {
        LocalDate.parse(iso).format(DateTimeFormatter.ofPattern("d MMM"))
    }.getOrDefault(iso)

// 7.5 → "7h 30m", 8.083 → "8h 05m".
internal fun hoursToHm(hours: Double): String {
    val totalMin = (hours * 60).roundToInt()
    return "${totalMin / 60}h ${"%02d".format(totalMin % 60)}m"
}

@Composable
internal fun TrendBadge(t: RecoveryTrend, higherIsBetter: Boolean) {
    val pct = (t.deltaPct * 100).roundToInt()
    val good = if (higherIsBetter) pct >= 0 else pct <= 0
    val arrow = if (pct > 0) "↑" else if (pct < 0) "↓" else "→"
    Text(
        "$arrow${kotlin.math.abs(pct)}%",
        style = MaterialTheme.typography.labelMedium,
        color = readinessColor(if (good) "green" else "red"),
    )
}
