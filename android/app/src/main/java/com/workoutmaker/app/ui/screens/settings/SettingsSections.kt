package com.workoutmaker.app.ui.screens.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import com.workoutmaker.app.data.EnduranceGoals
import com.workoutmaker.app.ui.screens.onboarding.EnduranceSportQuestions
import com.workoutmaker.app.ui.screens.onboarding.GYM
import com.workoutmaker.app.ui.screens.onboarding.GymGoalPicker
import com.workoutmaker.app.ui.screens.onboarding.GymKitPicker
import com.workoutmaker.app.ui.screens.onboarding.GymLevelPicker
import com.workoutmaker.app.ui.screens.onboarding.GymSceneCard
import com.workoutmaker.app.ui.screens.onboarding.GymSplitPicker
import com.workoutmaker.app.ui.screens.onboarding.gymSummary
import com.workoutmaker.app.ui.screens.onboarding.toggledGymKit
import com.workoutmaker.app.ui.screens.onboarding.WeekPreviewBars
import com.workoutmaker.app.ui.theme.palette
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.FitnessCenter
import androidx.compose.material.icons.filled.Pool
import androidx.compose.material.icons.automirrored.filled.DirectionsBike
import androidx.compose.material.icons.automirrored.filled.DirectionsRun
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.ScreenLockPortrait
import androidx.compose.material.icons.outlined.WbTwilight
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.automirrored.outlined.ShowChart
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.TextButton
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.data.WeightUnit
import com.workoutmaker.app.data.format
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SectionLabel
import com.workoutmaker.app.ui.components.SegmentedToggle
import android.app.Activity
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.contentColorFor
import com.workoutmaker.app.data.Periodization
import com.workoutmaker.app.ui.components.EmptyState
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import com.workoutmaker.app.data.addRace
import com.workoutmaker.app.data.deleteRace
import com.workoutmaker.app.data.races
import com.workoutmaker.app.data.saveProfile
import com.workoutmaker.app.data.setAutoPlan

// The one-page "Profile & week" grew too crowded, so it's now three pages
// (About you / Sports & goals / Your training week). They all edit the same
// TrainingProfile in the shared SettingsViewModel and each Save writes the
// whole profile, so nothing is lost when hopping between pages mid-edit.

@Composable
private fun SaveProfileButton(vm: SettingsViewModel) {
    val busy by vm.busy.collectAsStateSafe()
    val haptics = LocalHapticFeedback.current
    Button(
        onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); vm.saveProfile() },
        enabled = !busy, modifier = Modifier.fillMaxWidth(),
    ) { Text("Save profile") }
}

@Composable
internal fun AboutYouSection(vm: SettingsViewModel, onOpenBodyHistory: () -> Unit) {
    val profile by vm.profile.collectAsStateSafe()
    // Injuries live on "Injuries & constraints", the briefing toggle on
    // "Planning" — this page is purely who you are, physically.
    SectionCard {
        // Your initials, so the screen about you opens with you on it. Falls back
        // to a person glyph before there is a name to take initials from.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(
                Modifier.size(52.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                val initials = profile.display_name.orEmpty().trim()
                    .split(" ").filter { it.isNotBlank() }.take(2)
                    .joinToString("") { it.first().uppercase() }
                if (initials.isBlank()) {
                    Icon(
                        Icons.Outlined.Person,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                } else {
                    Text(
                        initials,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            }
            Column(Modifier.weight(1f)) {
                Text(
                    profile.display_name?.takeIf { it.isNotBlank() } ?: "No name yet",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    "What the coach calls you",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        OutlinedTextField(
            profile.display_name ?: "", { v -> vm.updateProfile { it.copy(display_name = v.ifBlank { null }) } },
            label = { Text("Your name") }, placeholder = { Text("What the coach calls you") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        ChipGroup("Sex", listOf("Male", "Female"), profile.sex?.replaceFirstChar { c -> c.uppercase() }) { s ->
            // Tap the selected chip again to clear back to the Intervals value.
            vm.updateProfile { it.copy(sex = if (it.sex == s.lowercase()) null else s.lowercase()) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NumberField(
                profile.birth_year?.toString() ?: "",
                { v -> vm.updateProfile { it.copy(birth_year = v.toIntOrNull()?.takeIf { y -> y in 1900..LocalDate.now().year }) } },
                label = "Born", modifier = Modifier.weight(1f),
            )
            NumberField(
                profile.height_cm?.toString() ?: "",
                { v -> vm.updateProfile { it.copy(height_cm = v.toIntOrNull()?.takeIf { h -> h in 100..250 }) } },
                label = "Height cm", modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NumberField(
                profile.weight_kg?.toString() ?: "",
                { v -> vm.updateProfile { it.copy(weight_kg = v.toIntOrNull()?.takeIf { w -> w in 30..250 }) } },
                label = "Weight kg", modifier = Modifier.weight(1f),
            )
            NumberField(
                profile.body_fat_pct?.let { bf -> if (bf % 1.0 == 0.0) bf.toInt().toString() else bf.toString() } ?: "",
                { v -> vm.updateProfile { it.copy(body_fat_pct = v.toDoubleOrNull()?.takeIf { bf -> bf in 3.0..60.0 }) } },
                label = "Body fat %", decimal = true, modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(
                Icons.Outlined.Sync,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
            Text(
                "Weight and body fat sync from Intervals.icu and a Health Connect scale. Edit one to override it.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    // Body trends is a place to go, not a field to fill, so it reads as a row.
    SectionCard {
        Row(
            Modifier.fillMaxWidth().clickable { onOpenBodyHistory() },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.AutoMirrored.Outlined.ShowChart,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(end = 14.dp).size(22.dp),
            )
            Column(Modifier.weight(1f)) {
                Text("Body trends", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "Weight, body fat and lean mass over time",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.outline,
            )
        }
    }
    SaveProfileButton(vm)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SportsGoalsSection(vm: SettingsViewModel) {
    val profile by vm.profile.collectAsStateSafe()
    var expanded by remember { mutableStateOf<String?>(null) }

    // Every sport, chosen or not, as one row: what it is, what you have told me
    // about it, and a way in. A sport you do not train reads as an invitation
    // rather than an unticked box, and the summary line means you can see all
    // four states without opening anything.
    SPORTS.forEach { sport ->
        val on = profile.sports.contains(sport)
        SectionCard {
            Row(
                Modifier.fillMaxWidth().clickable {
                    if (!on) vm.updateProfile { it.copy(sports = it.sports.toggled(sport)) }
                    expanded = if (expanded == sport) null else sport
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    sportIcon(sport),
                    contentDescription = null,
                    tint = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(end = 14.dp).size(24.dp),
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        sportLabel(sport),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        sportSummary(sport, profile),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (on) {
                    // Dropping a sport is destructive enough to need its own
                    // target, not a second meaning for tapping the row.
                    TextButton(onClick = {
                        vm.updateProfile { it.copy(sports = it.sports.toggled(sport)) }
                        expanded = null
                    }) { Text("Remove") }
                }
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.outline,
                )
            }
            if (on && expanded == sport) SportDetail(sport, profile, vm)
        }
    }
    SaveProfileButton(vm)
}

/** One line saying what this sport is currently set to, for the row above. */
private fun sportSummary(sport: String, profile: TrainingProfile): String {
    if (!profile.sports.contains(sport)) return "Pick a goal to include it in planning"
    val target = profile.distance_goal_km[sport]?.takeIf { it > 0 }
        ?.let { EnduranceGoals.goalPhrase(sport, it, profile.goal_pace_sec_per_km[sport]) }
    val goals = profile.goals_by_sport[sport].orEmpty().joinToString(", ").ifBlank { null }
    val bits = listOfNotNull(target ?: goals, profile.experience_by_sport[sport])
    return bits.joinToString(" · ").ifBlank { "No goal set yet" }
}

private fun sportIcon(sport: String) = when (sport) {
    "run" -> Icons.AutoMirrored.Filled.DirectionsRun
    "ride" -> Icons.AutoMirrored.Filled.DirectionsBike
    "swim" -> Icons.Filled.Pool
    else -> Icons.Filled.FitnessCenter
}

@Composable
private fun SportDetail(sport: String, profile: TrainingProfile, vm: SettingsViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // The endurance sports get onboarding's own control, the line and the
            // flag, not a description of what it once recorded. This screen used
            // to print the picker's target as read-only text next to a Clear
            // button, because a goal chip tapped here would silently lose to the
            // distance target on save. There is nothing to lose to now: it is the
            // same control writing the same fields.
            ChipGroup("Program objective", if (sport == "strength") listOf("fitness", "strength", "hypertrophy", "return") else listOf("fitness", "performance", "technique", "return"), profile.program_objectives[sport] ?: "fitness") { objective ->
                vm.updateProfile { it.copy(program_objectives = it.program_objectives + (sport to objective)) }
            }
            val venues = when (sport) {
                "run" -> listOf("unspecified", "road", "trail", "treadmill")
                "ride" -> listOf("unspecified", "road", "gravel", "mtb", "indoor")
                "swim" -> listOf("pool", "open_water")
                else -> emptyList()
            }
            if (venues.isNotEmpty()) ChipGroup("Training venue", venues, profile.venues[sport] ?: if (sport == "swim") "pool" else "unspecified") { venue ->
                vm.updateProfile { it.copy(venues = it.venues + (sport to venue)) }
            }
            if (sport == "swim") {
                OpenWaterControls(profile) { f -> vm.updateProfile(f) }
                val pool = profile.pool ?: com.workoutmaker.app.data.PoolProfile()
                NumberField(profile.pool?.length?.toString() ?: "", { value ->
                    vm.updateProfile { it.copy(pool = value.toIntOrNull()?.takeIf { n -> n > 0 }?.let { n -> pool.copy(length = n) }) }
                }, label = "Pool length")
                NumberField(pool.seconds_per_length?.toString() ?: "", { value ->
                    vm.updateProfile { it.copy(pool = pool.copy(seconds_per_length = value.toDoubleOrNull()?.takeIf { n -> n > 0 && n <= 600 })) }
                }, label = "Comfortable seconds per pool length (optional)")
                ChipGroup("Pool units", listOf("m", "yd"), pool.unit) { unit -> vm.updateProfile { it.copy(pool = pool.copy(unit = unit)) } }
                ChipGroup("Comfortable stroke", listOf("freestyle", "backstroke", "breaststroke"), pool.strokes.firstOrNull()) { stroke ->
                    vm.updateProfile { it.copy(pool = pool.copy(strokes = listOf(stroke))) }
                }
            }
            when {
                EnduranceGoals.isEndurance(sport) ->
                    EnduranceSportQuestions(sport, profile) { f -> vm.updateProfile(f) }
                // The gym gets onboarding's own four controls, boxed one
                // question per card so the screen is scannable, with the scene
                // on top answering "what does my gym currently look like".
                sport == GYM -> GymSettings(profile, vm)
                else -> SportGoalsLevel(
                    sport = sport,
                    goals = profile.goals_by_sport[sport].orEmpty(),
                    level = profile.experience_by_sport[sport],
                    splitStyle = profile.split_style,
                    onGoalToggle = { g -> vm.updateProfile { it.copy(goals_by_sport = it.goals_by_sport.toggleIn(sport, g)) } },
                    onLevel = { lvl -> vm.updateProfile { it.copy(experience_by_sport = it.experience_by_sport + (sport to lvl)) } },
                    onSplit = { s -> vm.updateProfile { it.copy(split_style = if (s == "Auto") null else s) } },
                )
            }
    }
}

/**
 * The gym in Settings: the same four controls onboarding uses, each in its own
 * labelled box. Onboarding gets one question per screen because it is a guided
 * first pass; Settings gets one question per card because the athlete arrived
 * knowing which of the four they came to change.
 */
@Composable
private fun GymSettings(profile: TrainingProfile, vm: SettingsViewModel) {
    SectionCard {
        SectionLabel("Your gym")
        GymSceneCard(profile.equipment_list, caption = gymSummary(profile).ifBlank { null })
    }
    SectionCard {
        SectionLabel("What you're chasing")
        GymGoalPicker(profile) { g ->
            vm.updateProfile { it.copy(goals_by_sport = it.goals_by_sport.toggleIn(GYM, g)) }
        }
    }
    SectionCard {
        SectionLabel("Level")
        GymLevelPicker(profile) { lvl ->
            vm.updateProfile { it.copy(experience_by_sport = it.experience_by_sport + (GYM to lvl)) }
        }
    }
    SectionCard {
        SectionLabel("Preferred split")
        GymSplitPicker(profile) { s ->
            vm.updateProfile { it.copy(split_style = if (s == "Auto") null else s) }
        }
    }
    SectionCard {
        SectionLabel("Your kit")
        GymKitPicker(profile) { item ->
            vm.updateProfile { it.copy(equipment_list = toggledGymKit(it.equipment_list, item)) }
        }
    }
}

@Composable
internal fun TrainingWeekSection(vm: SettingsViewModel) {
    val profile by vm.profile.collectAsStateSafe()
    // Answer first, questions underneath, exactly as the onboarding step does it.
    // Chip rows can say "4 days, 60 minutes" but not which weekdays those are or
    // how the long day compares, and that shape is the thing worth checking when
    // you come back to this screen months later.
    SectionCard {
        SectionLabel("Your week")
        WeekPreviewBars(profile.day_availability)
    }
    SectionCard {
        SectionLabel("Your coach")
        Text("Choose your priorities and available time. Your coach fits the week around completed training, recovery and recorded restrictions.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PlanningChoiceGroup("Main focus", profile.sports.filter { it in listOf("run", "ride", "swim", "strength") }, profile.primary_sport) { sport ->
            vm.updateProfile { it.copy(primary_sport = sport) }
        }
        ToggleRow("My recent training is up to date", "Recorded and manual activities represent my last four weeks. Missing history keeps new workouts conservative.", profile.training_history_confirmed) { confirmed ->
            vm.updateProfile { it.copy(training_history_confirmed = confirmed) }
        }
        NumberField(profile.weekly_minutes_max?.toString() ?: "", { value ->
            vm.updateProfile { it.copy(weekly_minutes_max = value.toIntOrNull()?.takeIf { n -> n >= 0 }) }
        }, label = "Weekly time limit in minutes (optional)")
        Text("Time limits are ceilings. Sessions may be shorter while you build consistency.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    WeeklyAvailabilityEditor(profile.day_availability) { list -> vm.updateProfile { it.copy(day_availability = list) } }
    SectionCard {
        SectionLabel("Progression and recovery")
        PeriodizationControl(
            periodized = profile.periodized,
            onChange = { p -> vm.updateProfile { Periodization.configure(it, p) } },
            weeklyTssTarget = profile.weekly_tss_target,
        )
        Text(if (profile.automatic_event_preparation) "Goal races automatically guide preparation. You don't need to configure a separate taper." else "Automatic race preparation is off in advanced program options.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PlanningChoiceGroup("On recovery days", listOf("rest", "mobility", "optional_light", "active_recovery"), profile.recovery_day_style) { value ->
            vm.updateProfile { it.copy(recovery_day_style = value) }
        }
    }
    PlanningControls(profile) { f -> vm.updateProfile(f) }
    PlanningDetailsCard("Workout generation options", if (profile.prescription_engine == "deterministic") "Structured workouts" else "AI-proposed workouts") {
        ToggleRow("Structured workouts", "Use consistent workout recipes. Turn off for AI proposals. Both are checked against your training restrictions.",
            profile.prescription_engine == "deterministic") { enabled ->
            vm.updateProfile { it.copy(prescription_engine = if (enabled) "deterministic" else "model") }
        }
        Text("Custom written requests can still use the coach with structured workouts enabled.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    PlanningDetailsCard("Training load illustration", "Eight-week example, not your scheduled workouts") {
        Text("This chart illustrates a load pattern using your TSS target. Actual workouts are rebuilt from completed training and feedback; the structured planner does not follow these exact numbers.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PeriodizationNumbers(profile.weekly_tss_target, profile.periodized, showHeading = false)
    }
    Text("Save these preferences, then generate or adjust your week to use them.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    SaveProfileButton(vm)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun WorkoutDefaultsSection(vm: SettingsViewModel) {
    val s by vm.appSettings.collectAsStateSafe()
    SectionCard {
        // Two units, so a two-way switch rather than two chips that happen to
        // be exclusive (same reasoning as SegmentedToggle everywhere else).
        SegmentedToggle(
            WeightUnit.entries.first().label,
            WeightUnit.entries.last().label,
            right = s.units == WeightUnit.entries.last(),
            onChange = { right -> vm.setUnits(if (right) WeightUnit.entries.last() else WeightUnit.entries.first()) },
        )
        Text(
            "Used by the plate maths and every weight label in the app.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    SectionCard {
        Text("Rest between sets, when a lift doesn't say", style = MaterialTheme.typography.titleSmall)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { vm.setDefaultRest((s.defaultRestSec - 15).coerceAtLeast(0)) }) { Text("−15") }
            Text(
                restLabel(s.defaultRestSec),
                Modifier.weight(1f),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            OutlinedButton(onClick = { vm.setDefaultRest(s.defaultRestSec + 15) }) { Text("+15") }
        }
    }
    SectionCard {
        Text("Bar weight the plate maths subtracts", style = MaterialTheme.typography.titleSmall)
        ChoiceTiles(
            BAR_WEIGHTS.take(3).map { w ->
                TileChoice(
                    label = s.units.suffix,
                    value = s.units.format(w),
                    selected = s.barbellKg == w,
                    onClick = { vm.setBarbell(w) },
                )
            },
        )
        // The fourth bar (7 kg) is rare enough to sit under the tiles rather
        // than squash them, but it must stay reachable.
        BAR_WEIGHTS.drop(3).forEach { w ->
            FilterChip(
                selected = s.barbellKg == w,
                onClick = { vm.setBarbell(w) },
                label = { Text("${s.units.format(w)} ${s.units.suffix}") },
            )
        }
    }
    SectionCard {
        IconToggleRow(
            Icons.Outlined.ScreenLockPortrait,
            "Keep the screen awake",
            "While a session is running",
            s.keepScreenOn,
        ) { vm.setKeepScreenOn(it) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PlanningSection(vm: SettingsViewModel) {
    val autoPlan by vm.autoPlan.collectAsStateSafe()
    val profile by vm.profile.collectAsStateSafe()
    val busy by vm.busy.collectAsStateSafe()
    val haptics = LocalHapticFeedback.current
    SectionCard {
        IconToggleRow(
            Icons.Outlined.CalendarMonth,
            "Write next week for me",
            "Sunday evening, pushed to your watch",
            autoPlan,
        ) { vm.setAutoPlan(it) }
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHigh)
        // Saved immediately — a toggle that silently needs a Save button reads
        // as broken. (Moved here from Profile: it's coach behavior, not identity.)
        IconToggleRow(
            Icons.Outlined.WbTwilight,
            "Morning briefing",
            "A note from your coach on Home, about one AI call a day",
            profile.briefing,
        ) { checked ->
            vm.updateProfile { it.copy(briefing = checked) }
            vm.saveProfile()
        }
    }
    SectionCard {
        Text("How much load should a normal week carry?", style = MaterialTheme.typography.titleSmall)
        // The same three options onboarding offers, as tiles: each is a fraction
        // of the athlete's OWN availability ceiling, so the number beside the
        // name is the part worth comparing, and none of them is out of reach.
        val minutes = profile.day_availability.sumOf { it.max_minutes }
        val ceiling = Periodization.availabilityCeiling(minutes)
        if (ceiling != null) {
            ChoiceTiles(
                Periodization.Effort.entries.map { e ->
                    val target = e.targetFor(ceiling)
                    TileChoice(
                        label = e.label,
                        value = "~$target",
                        selected = profile.weekly_tss_target == target,
                        onClick = { vm.updateProfile { it.copy(weekly_tss_target = target) } },
                    )
                },
            )
            Text(
                "Priced from your ${durationLabel(minutes)} week, so none of these is out of reach.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(
                "Set your training days first and these price themselves from the time you actually have.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // Kept: the exact-number escape hatch, for anyone who knows the TSS they want.
        OutlinedTextField(
            (profile.weekly_tss_target?.toString() ?: ""), { v -> vm.updateProfile { it.copy(weekly_tss_target = v.toIntOrNull()) } },
            label = { Text("Or set the number yourself") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
        )
    }
    SectionCard {
        Text("And how hard should it feel?", style = MaterialTheme.typography.titleSmall)
        ChoiceTiles(
            listOf("Easier" to "easier", "Standard" to null, "Harder" to "harder").map { (label, value) ->
                TileChoice(
                    label = label,
                    value = when (value) {
                        "easier" -> "−"
                        "harder" -> "+"
                        else -> "="
                    },
                    selected = profile.challenge == value,
                    onClick = { vm.updateProfile { it.copy(challenge = value) } },
                )
            },
        )
        Text(
            "A standing bias, on top of which the coach still adapts to your daily readiness.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    Button(
        onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); vm.saveProfile() },
        enabled = !busy, modifier = Modifier.fillMaxWidth(),
    ) { Text("Save") }
}











@Composable
internal fun AppearanceSection(vm: SettingsViewModel) {
    val s by vm.appSettings.collectAsStateSafe()
    // Palette + light/dark now live in the shared AppearancePicker (ProfileEditors.kt)
    // so onboarding and Settings render the exact same control.
    SectionCard {
        AppearancePicker(
            themeMode = s.themeMode,
            palette = s.themePalette,
            onMode = { vm.setThemeMode(it) },
            onPalette = { vm.setThemePalette(it) },
            // The detail header above already says what this screen is.
            label = null,
        )
    }
}

// ---------------------------------------------------------------------------
// P1 — goal races (A/B/C) + countdown
// ---------------------------------------------------------------------------
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RacesSection(vm: SettingsViewModel) {
    val races by vm.races.collectAsStateSafe()
    val profile by vm.profile.collectAsStateSafe()
    var showAdd by remember { mutableStateOf(false) }
    val today = LocalDate.now()

    // The goal that currently owns the plan, so a tune-up can be told what it is
    // being planned around.
    val mainGoal = races.firstOrNull { it.date == profile.goal_date }
    if (showAdd) AddGoalSheet(onClose = { showAdd = false }, mainGoal = mainGoal) { draft ->
        vm.addRace(draft); showAdd = false
    }

    // Nothing set yet is the common case here, so it gets a real screen rather
    // than an apologetic line above an empty list: what a goal buys you, one
    // button, and three shortcuts for the goals people actually set.
    if (races.isEmpty()) {
        SectionCard {
            Column(
                Modifier.fillMaxWidth().padding(vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier.size(56.dp).background(MaterialTheme.colorScheme.surfaceContainerLowest, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Flag,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(26.dp),
                    )
                }
                Text("No goals yet", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "B and C goals show on the countdown as tune-ups.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Button(onClick = { showAdd = true }) { Text("Add your first goal") }
            }
        }
    }
    SectionCard {
        if (races.isNotEmpty()) {
            Text(
                "Races, FTP targets, swim times, lifts. B and C goals are tune-ups shown on the countdown.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        races.forEach { r ->
            val days = runCatching { ChronoUnit.DAYS.between(today, LocalDate.parse(r.date)) }.getOrNull()
            val isGoal = profile.goal_date == r.date
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                val dotColor = priorityColor(r.priority)
                Box(Modifier.size(26.dp).background(dotColor, CircleShape),
                    contentAlignment = Alignment.Center) {
                    Text(r.priority, style = MaterialTheme.typography.labelMedium,
                        color = contentColorFor(dotColor))
                }
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    Text(r.name + if (isGoal) "  ⭐" else "", style = MaterialTheme.typography.titleSmall)
                    Text(buildString {
                        append(goalSportLabel(r.sport))
                        append(" · ${r.date}")
                        r.distance?.let { append(" · $it") }
                        r.target?.let { append(" · $it") }
                        days?.let { append(" · ${if (it >= 0) "$it days" else "past"}") }
                    }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!isGoal) TextButton(onClick = { vm.makeGoalRace(r) }) { Text("Set goal") }
                r.id?.let { IconButton(onClick = { vm.deleteRace(r) }) {
                    Icon(Icons.Filled.Delete, "Delete goal", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                } }
            }
        }
        OutlinedButton(onClick = { showAdd = true }, modifier = Modifier.fillMaxWidth()) { Text("Add goal") }
        // Shortcuts into the same dialog for the three goals people actually
        // set. They only pre-frame the ask; the dialog still owns every field.
        SectionLabel("Quick add")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("10K race", "FTP target", "Lift PR").forEach { label ->
                FilterChip(selected = false, onClick = { showAdd = true }, label = { Text(label) })
            }
        }
    }
}


// --- Shared bits -----------------------------------------------------------
