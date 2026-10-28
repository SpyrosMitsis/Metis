package com.workoutmaker.app.ui.screens.home

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import com.workoutmaker.app.data.Workout
import com.workoutmaker.app.ui.components.ChipRow
import com.workoutmaker.app.ui.components.QuoteBlock
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.font.FontWeight
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.data.WorkoutSection
import com.workoutmaker.app.data.Zones
import com.workoutmaker.app.ui.theme.amberAccent
import com.workoutmaker.app.ui.screens.settings.ZoneTables

internal fun rpeWord(n: Int): String = when {
    n <= 2 -> "very easy"
    n <= 4 -> "easy"
    n <= 6 -> "moderate"
    n <= 8 -> "hard"
    n == 9 -> "very hard"
    else -> "max effort"
}

// Increasing-bars RPE picker: bars 1-10 grow in height; tapping bar n lights
// bars 1..n (green → amber → red).
@Composable
internal fun RpeBars(selected: Int?, onSelect: (Int) -> Unit) {
    // Capture theme colors here (a local fun can't invoke composables).
    val easy = MaterialTheme.colorScheme.primary
    val mid = amberAccent()
    val hard = MaterialTheme.colorScheme.error
    fun barColor(n: Int) = when {
        n <= 5 -> easy
        n <= 8 -> mid
        else -> hard
    }
    val haptics = LocalHapticFeedback.current
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        (1..10).forEach { n ->
            val active = selected != null && n <= selected
            val bg by animateColorAsState(
                if (active) barColor(n) else MaterialTheme.colorScheme.surfaceContainerHigh,
                label = "rpeBar",
            )
            Box(
                Modifier
                    .weight(1f)
                    .size(width = 0.dp, height = (10 + n * 3).dp)
                    .background(bg, RoundedCornerShape(3.dp))
                    .clickable(onClickLabel = "RPE $n, ${rpeWord(n)}") {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        onSelect(n)
                    },
            )
        }
    }
}

@Composable
fun WorkoutDetail(w: Workout, profile: TrainingProfile? = null) {
    val thresholdSecPerKm = profile?.threshold_pace_per_km?.let { Zones.parsePace(it) }
    val lthr = profile?.lthr
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(com.workoutmaker.app.strength.displayWorkoutTitle(w), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        ChipRow(
            listOfNotNull(
                w.type.takeIf { it.isNotBlank() },
                "${w.duration_minutes.toInt()} min".takeIf { w.duration_minutes > 0 },
                "RPE ${w.rpe_target.toInt()}".takeIf { w.rpe_target > 0 },
                "~${w.tss_estimate.toInt()} TSS".takeIf { w.tss_estimate > 0 },
            ),
        )
        w.prescription?.let { prescription ->
            val context = androidx.compose.ui.platform.LocalContext.current
            androidx.compose.material3.TextButton(onClick = {
                val data = "{\"format\":\"workout-maker-prescription\",\"version\":1,\"prescription\":$prescription}"
                context.startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = "application/json"; putExtra(android.content.Intent.EXTRA_TEXT, data)
                }, "Export workout"))
            }) { Text("Export workout (.json)") }
        }
        if (w.coach_note.isNotBlank()) QuoteBlock(w.coach_note)
        if (w.type == "strength") {
            val groups = com.workoutmaker.app.strength.plannedExerciseGroups(w)
            Text("${groups.size} exercises", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                groups.forEach { group ->
                    var showNotes by remember(group.name) { mutableStateOf(false) }
                    val notes = group.doses.map { it.exercise.notes }.filter { it.isNotBlank() }.distinct()
                    Column(
                        Modifier.fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(10.dp))
                            .semantics {
                                if (notes.isNotEmpty()) stateDescription = if (showNotes) "Notes expanded" else "Notes collapsed"
                            }
                            .clickable(
                                enabled = notes.isNotEmpty(),
                                role = Role.Button,
                                onClickLabel = if (showNotes) "Hide exercise notes" else "Show exercise notes",
                            ) { showNotes = !showNotes }
                            .heightIn(min = 48.dp)
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(group.name, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            if (notes.isNotEmpty()) Text(
                                if (showNotes) "▴" else "▾",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        group.doses.forEach { dose ->
                            val ex = dose.exercise
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(
                                    if (dose.warmup) "Warm-up" else "Working",
                                    Modifier.width(58.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    "${ex.sets} × ${ex.reps}" + (ex.weight_kg?.let { " · $it kg" } ?: "") +
                                        (ex.rest_seconds?.let { " · ${it}s rest" } ?: "") + (" · each side".takeIf { ex.notes.contains("Each side", ignoreCase = true) } ?: ""),
                                    Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        if (showNotes) notes.forEach {
                            Text(it, Modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        } else w.sections.forEach { section -> WorkoutSectionItem(section.copy(name = section.name.replace(Regex("^warmup:.*", RegexOption.IGNORE_CASE), "Warm-up").replace(Regex("^main:.*", RegexOption.IGNORE_CASE), "Main session").replace(Regex("^cooldown:.*", RegexOption.IGNORE_CASE), "Cool-down")), thresholdSecPerKm, lthr) }

        // "Your zones" peek — only for endurance days where thresholds are set.
        val isEndurance = listOf("run", "ride", "bike", "cycl").any { w.type.contains(it, ignoreCase = true) }
        val hasThresholds = profile != null && (profile.lthr != null || profile.threshold_pace_per_km != null || profile.ftp != null)
        if (isEndurance && hasThresholds) {
            var zonesOpen by remember { mutableStateOf(false) }
            Text(
                (if (zonesOpen) "▾ Your zones" else "▸ Your zones"),
                Modifier.clickable { zonesOpen = !zonesOpen },
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
            )
            if (zonesOpen) ZoneTables(profile!!.lthr, profile.threshold_pace_per_km, profile.ftp)
        }
    }
}

@Composable
private fun WorkoutSectionItem(
    section: WorkoutSection,
    thresholdSecPerKm: Int? = null,
    lthr: Int? = null,
) {
    // Total work time for the section (duration-based steps × their repeats).
    val sectionSec = section.exercises.sumOf { ex ->
        (Zones.parseDurationSec(ex.reps) ?: 0) * ex.sets.coerceAtLeast(1)
    }
    Row(verticalAlignment = Alignment.Top) {
        Box(
            Modifier.size(30.dp)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.16f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                section.name.trim().firstOrNull()?.uppercase() ?: "•",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold,
            )
        }
        Column(Modifier.padding(start = 12.dp)) {
            Text(
                section.name + if (sectionSec > 0) "  ·  ${com.workoutmaker.app.data.Zones.fmtDurationShort(sectionSec)}" else "",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            section.exercises.forEach { ex ->
                val durSec = Zones.parseDurationSec(ex.reps)
                val zoneLabel = (ex.pace_zone ?: ex.hr_zone)?.let { z ->
                    Zones.zoneNum(z)?.let { "Z$it" }
                }
                if (durSec != null || zoneLabel != null) {
                    // Endurance step: "5× · 3 min · Z4 · 4:15–4:30 /km".
                    val target = Zones.targetRange(ex.pace_zone, ex.hr_zone, thresholdSecPerKm, lthr)
                    val meta = listOfNotNull(
                        "${ex.sets}×".takeIf { ex.sets > 1 },
                        durSec?.let { Zones.fmtDurationShort(it) },
                        zoneLabel,
                        target,
                    ).joinToString(" · ")
                    StepLine(ex.name, meta)
                } else {
                    // Strength / other step: keep the sets×reps · kg rendering.
                    val meta = buildString {
                        if (ex.sets > 0 && ex.reps.isNotEmpty()) append("${ex.sets}×${ex.reps}")
                        ex.weight_kg?.let { append(" · ${it}kg") }
                    }
                    StepLine(ex.name, meta)
                }
            }
        }
    }
}

@Composable
private fun StepLine(name: String, meta: String) {
    Text(
        "$name${if (meta.isNotBlank()) "  ·  $meta" else ""}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
