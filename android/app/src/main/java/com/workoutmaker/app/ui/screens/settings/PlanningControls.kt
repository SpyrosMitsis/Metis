package com.workoutmaker.app.ui.screens.settings

import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.foundation.clickable
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.*
import com.workoutmaker.app.strength.ExerciseMetadataCatalog
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SectionLabel
import java.time.LocalDate

@Composable
internal fun PlanningControls(profile: TrainingProfile, update: ((TrainingProfile) -> TrainingProfile) -> Unit) {
    PlanningDetailsCard("Advanced schedule options", "${profile.session_windows.count { it.slot == 1 }} double-workout days · optional") {
        Text("Only use this if you want two separate workouts in one day, such as a morning swim and evening strength session. Your normal training days need no extra setup.", style = MaterialTheme.typography.bodySmall)
        PlanningChoiceGroup("Multisport goal", listOf("none", "triathlon", "duathlon"), profile.multisport_goal) { value -> update { it.copy(multisport_goal = value) } }
        NumberField(profile.minimum_session_gap_minutes.toString(), { value -> value.toIntOrNull()?.takeIf { it >= 60 }?.let { n -> update { it.copy(minimum_session_gap_minutes = n) } } }, "Recovery between separate sessions (minutes)")
        (profile.days.ifEmpty { listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun") }).forEach { day ->
            val windows = profile.session_windows.filter { it.day == day }
            ToggleRow("$day: two sessions", "Reserve a separate window for each session", windows.any { it.slot == 1 }) { enabled ->
                update { p -> p.copy(session_windows = p.session_windows.filterNot { it.day == day } + if (enabled) listOf(SessionWindow(day, 0, 420, ((p.session_duration_max ?: p.session_duration ?: 60) / 2).coerceAtLeast(10)), SessionWindow(day, 1, 1080, ((p.session_duration_max ?: p.session_duration ?: 60) / 2).coerceAtLeast(10))) else emptyList()) }
            }
            windows.sortedBy { it.slot }.forEach { window ->
                var time by remember(day, window.slot) { mutableStateOf("%02d:%02d".format(window.start_minute / 60, window.start_minute % 60)) }
                OutlinedTextField(time, { text -> time = text; val match = Regex("^(\\d{1,2}):(\\d{2})$").matchEntire(text)
                    if (match != null) { val h = match.groupValues[1].toInt(); val m = match.groupValues[2].toInt()
                        if (h in 0..23 && m in 0..59) update { p -> p.copy(session_windows = p.session_windows.map { if (it.day == day && it.slot == window.slot) it.copy(start_minute = h * 60 + m) else it }) }
                    }
                }, label = { Text("$day session ${window.slot + 1}: local start (HH:mm)") }, singleLine = true)
                NumberField(window.max_minutes.toString(), { text -> text.toIntOrNull()?.takeIf { it > 0 }?.let { n -> update { p -> p.copy(session_windows = p.session_windows.map { if (it.day == day && it.slot == window.slot) it.copy(max_minutes = n) else it }) } } }, "Available minutes")
            }
        }
    }
    PlanningDetailsCard("Advanced program options", if (profile.automatic_event_preparation) "Goal-race preparation is automatic · optional overrides" else "Automatic race preparation is off") {
        Text("When your coach builds or adjusts a plan, dated goal races automatically guide the preparation window. Tune-up events do not receive a full goal-race reduction. Change these settings only to override the default.", style = MaterialTheme.typography.bodySmall)
        ToggleRow("Automatic goal-race preparation", "Use the preparation preset for your A-priority goal races", profile.automatic_event_preparation) { enabled -> update { it.copy(automatic_event_preparation = enabled) } }
        OutlinedTextField(profile.program_started_on.orEmpty(), { value -> update { it.copy(program_started_on = value.ifBlank { null }) } }, label = { Text("Program start (YYYY-MM-DD)") }, singleLine = true)
        profile.sports.filter { it in listOf("run", "ride", "swim", "strength") }.forEach { sport ->
            val policy = profile.event_policies[sport]
            ToggleRow("$sport: custom preparation", "Override automatic preparation for this sport", policy != null) { enabled ->
                update { it.copy(event_policies = if (enabled) it.event_policies + (sport to EventPreparationPolicy(7, 0.7)) else it.event_policies - sport) }
            }
            policy?.let {
                NumberField(it.days.toString(), { value -> value.toIntOrNull()?.takeIf { n -> n in 1..28 }?.let { n -> update { p -> p.copy(event_policies = p.event_policies + (sport to policy.copy(days = n))) } } }, "Preparation days")
                NumberField((it.duration_factor * 100).toInt().toString(), { value -> value.toIntOrNull()?.takeIf { n -> n in 1..100 }?.let { n -> update { p -> p.copy(event_policies = p.event_policies + (sport to policy.copy(duration_factor = n / 100.0))) } } }, "Usual duration retained (%)")
                ToggleRow("Keep eligible quality work", "Availability and recovery checks still apply", policy.allow_quality) { enabled -> update { p -> p.copy(event_policies = p.event_policies + (sport to policy.copy(allow_quality = enabled))) } }
            }
        }
    }
    PlanningDetailsCard("Equipment details", profile.implements?.let { "${it.size} items selected" } ?: "Using your existing equipment preferences") {
        Text("Choose individual items to override your general equipment settings. Include benches, racks and anchors; an empty inventory means bodyweight only.", style = MaterialTheme.typography.bodySmall)
        if (profile.implements != null) TextButton(onClick = { update { it.copy(implements = null) } }) { Text("Use general equipment settings") }
        var search by remember { mutableStateOf("") }
        OutlinedTextField(search, { search = it }, label = { Text("Find an implement or machine") })
        ExerciseMetadataCatalog.implements.plus(listOf("treadmill", "indoor_trainer", "stationary_bike", "power_meter", "heart_rate_monitor")).distinct().filter { it.replace('_', ' ').contains(search, ignoreCase = true) }.forEach { item ->
            Row { Checkbox(profile.implements?.contains(item) == true, { enabled -> update { p -> p.copy(implements = if (enabled) (p.implements.orEmpty() + item).distinct() else p.implements.orEmpty() - item) } }); Text(item.replace('_', ' '), Modifier.padding(top = 12.dp)) }
        }
    }
    PlanningDetailsCard("Performance tests", "${profile.calibrations.size} recorded · optional pace, power and heart-rate tests") {
        profile.calibrations.forEachIndexed { index, c ->
            Text("${c.sport}: ${c.kind}, ${c.value}, ${c.date} (${c.reliability})", style = MaterialTheme.typography.bodySmall)
            TextButton({ update { p -> p.copy(calibrations = p.calibrations.filterIndexed { i, _ -> i != index }) } }) { Text("Remove") }
        }
        var sport by rememberSaveable { mutableStateOf("run") }; var kind by rememberSaveable { mutableStateOf("pace") }
        var value by rememberSaveable { mutableStateOf("") }; var date by rememberSaveable { mutableStateOf(LocalDate.now().toString()) }
        var distance by rememberSaveable { mutableStateOf("") }
        var reliability by rememberSaveable { mutableStateOf("measured") }
        PlanningChoiceGroup("Sport", listOf("run", "ride", "swim"), sport) { sport = it }
        PlanningChoiceGroup("Measurement", listOf("pace", "power", "heart_rate", "personal_best"), kind) { kind = it }
        Text("Pace: seconds/km for running, seconds/100m for swimming. Power: watts. Heart rate: threshold bpm. Personal best: elapsed seconds (never treated as a threshold).", style = MaterialTheme.typography.bodySmall)
        if (kind == "personal_best") NumberField(distance, { distance = it }, "Distance (metres)")
        NumberField(value, { value = it }, "Measurement value")
        OutlinedTextField(date, { date = it }, label = { Text("Test date (YYYY-MM-DD)") })
        PlanningChoiceGroup("Reliability", listOf("measured", "estimated", "unknown"), reliability) { reliability = it }
        TextButton(onClick = { val number = value.toDoubleOrNull(); if (number != null && number > 0 && (kind != "personal_best" || (distance.toDoubleOrNull() ?: 0.0) > 0) && runCatching { LocalDate.parse(date) }.isSuccess) { update { it.copy(calibrations = it.calibrations + CalibrationRecord(sport, kind, number, date, reliability, distance.toDoubleOrNull())) }; value = "" } }) { Text("Add calibration") }
    }
}

/** Keep everyday decisions visible; specialist controls remain available on demand. */
@Composable
internal fun PlanningDetailsCard(title: String, summary: String, content: @Composable () -> Unit) {
    var expanded by rememberSaveable(title) { mutableStateOf(false) }
    val draftState = rememberSaveableStateHolder()
    SectionCard {
        Row(
            Modifier.fillMaxWidth()
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide $title" else "Show $title") { expanded = !expanded }
                .heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(if (expanded) "▴" else "▾", color = MaterialTheme.colorScheme.primary)
        }
        if (expanded) draftState.SaveableStateProvider(title) { content() }
    }
}

@Composable
internal fun PlanningChoiceGroup(label: String, values: List<String>, selected: String?, onSelect: (String) -> Unit) {
    val names = mapOf(
        "run" to "Running", "ride" to "Cycling", "swim" to "Swimming", "strength" to "Strength",
        "none" to "None", "triathlon" to "Triathlon", "duathlon" to "Duathlon",
        "rest" to "Rest", "mobility" to "Mobility", "optional_light" to "Optional light movement", "active_recovery" to "Active recovery",
        "pace" to "Pace", "power" to "Power", "heart_rate" to "Threshold heart rate", "personal_best" to "Personal best",
        "measured" to "Measured", "estimated" to "Estimated", "unknown" to "Unknown",
    )
    val labels = values.associateBy { names[it] ?: it }
    ChipGroup(label, labels.keys.toList(), names[selected] ?: selected) { labels[it]?.let(onSelect) }
}

@Composable
internal fun OpenWaterControls(profile: TrainingProfile, update: ((TrainingProfile) -> TrainingProfile) -> Unit) {
    val checks = profile.open_water ?: OpenWaterChecks()
    SectionCard {
        SectionLabel("Open-water venue checks")
        Text("These record your confirmations, not a safety assurance. Pool fallback is used when checks for the session date are unavailable.", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(checks.date, { date -> update { it.copy(open_water = checks.copy(date = date)) } }, label = { Text("Confirmed session date (YYYY-MM-DD)") })
        ToggleRow("Prior open-water experience", "Pool experience alone does not establish this", checks.experienced) { v -> update { it.copy(open_water = checks.copy(experienced = v)) } }
        ToggleRow("Supervised venue", "An organized, supervised swimming location", checks.supervised_venue) { v -> update { it.copy(open_water = checks.copy(supervised_venue = v)) } }
        ToggleRow("Buddy arranged", "A swimming partner is confirmed", checks.buddy) { v -> update { it.copy(open_water = checks.copy(buddy = v)) } }
        ToggleRow("Venue is open", "Confirmed for this date", checks.venue_open) { v -> update { it.copy(open_water = checks.copy(venue_open = v)) } }
        ToggleRow("Venue permits current conditions", "Follow the venue's operating guidance", checks.conditions_approved_by_venue) { v -> update { it.copy(open_water = checks.copy(conditions_approved_by_venue = v)) } }
        ChipGroup("Comfortable stroke", listOf("freestyle", "breaststroke", "backstroke"), checks.stroke) { v -> update { it.copy(open_water = checks.copy(stroke = v)) } }
        NumberField(checks.max_minutes.toString(), { v -> v.toIntOrNull()?.takeIf { n -> n in 10..120 }?.let { n -> update { it.copy(open_water = checks.copy(max_minutes = n)) } } }, "Confirmed session limit (minutes)")
    }
}
