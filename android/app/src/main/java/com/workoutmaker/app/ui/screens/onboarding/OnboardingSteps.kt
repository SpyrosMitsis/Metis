package com.workoutmaker.app.ui.screens.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.DirectionsBike
import androidx.compose.material.icons.automirrored.filled.DirectionsRun
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.FitnessCenter
import androidx.compose.material.icons.filled.Pool
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.EnduranceGoals
import com.workoutmaker.app.data.Race
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.data.Periodization
import com.workoutmaker.app.ui.components.SectionLabel
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import com.workoutmaker.app.ui.screens.settings.AddGoalSheet
import com.workoutmaker.app.ui.screens.settings.AppearancePicker
import com.workoutmaker.app.ui.screens.settings.ChipGroup
import com.workoutmaker.app.ui.screens.settings.EXPERIENCE_BY_SPORT
import com.workoutmaker.app.ui.screens.settings.GOALS_BY_SPORT
import com.workoutmaker.app.ui.screens.settings.LEVELS
import com.workoutmaker.app.ui.screens.settings.PerformanceEditor
import com.workoutmaker.app.ui.screens.settings.PeriodizationControl
import com.workoutmaker.app.ui.screens.settings.PeriodizationNumbers
import com.workoutmaker.app.ui.screens.settings.SPORTS
import com.workoutmaker.app.ui.screens.settings.SportGoalsLevel
import com.workoutmaker.app.ui.screens.settings.WeeklyAvailabilityEditor
import com.workoutmaker.app.ui.screens.settings.durationLabel
import com.workoutmaker.app.ui.screens.settings.sportLabel
import com.workoutmaker.app.ui.screens.settings.toggleIn
import com.workoutmaker.app.ui.screens.settings.toggled

@Composable
internal fun StepWelcome(vm: OnboardingViewModel) {
    val s by vm.appSettings.collectAsStateSafe()
    StepColumn {
        // The coach introduces itself before it interrogates you. Centred hero,
        // not a form label: this is the only screen with nothing to fill in, so
        // it is the one chance to set who is doing the asking.
        Column(
            Modifier.fillMaxWidth().padding(vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(
                Modifier.size(76.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Psychology,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(38.dp),
                )
            }
            Text(
                "I'll write your training. First, tell me about you.",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            Text(
                "A few quick steps. Everything is optional and changeable in Settings.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        // The theme picker rides along here (it used to be a whole step): one
        // fewer screen between the athlete and the questions that matter.
        AppearancePicker(
            themeMode = s.themeMode,
            palette = s.themePalette,
            onMode = { vm.setThemeMode(it) },
            onPalette = { vm.setThemePalette(it) },
        )
    }
}

@Composable
internal fun StepAppearance(vm: OnboardingViewModel) {
    val s by vm.appSettings.collectAsStateSafe()
    StepColumn {
        AppearancePicker(
            themeMode = s.themeMode,
            palette = s.themePalette,
            onMode = { vm.setThemeMode(it) },
            onPalette = { vm.setThemePalette(it) },
            // This step's own header is "Make it yours" already.
            label = null,
        )
    }
}

@Composable
internal fun StepPersonal(profile: TrainingProfile, vm: OnboardingViewModel) {
    val year = LocalDate.now().year
    StepColumn {
        // The "why we ask" line lives in the step header now (stepHeadline).
        OutlinedTextField(
            profile.display_name ?: "",
            { v -> vm.update { it.copy(display_name = v.ifBlank { null }) } },
            label = { Text("Your name") },
            placeholder = { Text("What should the coach call you?") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        // "Other" is stored but the backend only uses M/F for demographics, so
        // it reads as "not stated" downstream — the honest treatment.
        ChipGroup("Sex", listOf("Male", "Female", "Other"), profile.sex?.replaceFirstChar { c -> c.uppercase() }) { s ->
            vm.update { it.copy(sex = if (it.sex == s.lowercase()) null else s.lowercase()) }
        }
        // Single-word labels + unit suffixes keep all three boxes the same height.
        // Soft validation: an out-of-range value shows red but never blocks —
        // the guard is against typos (SetSanity philosophy), not the athlete.
        val ageBad = profile.birth_year?.let { (year - it) !in 10..100 } == true
        val heightBad = profile.height_cm?.let { it !in 100..230 } == true
        val weightBad = profile.weight_kg?.let { it !in 30..250 } == true
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                profile.birth_year?.let { (year - it).toString() } ?: "",
                { v -> vm.update { it.copy(birth_year = v.toIntOrNull()?.let { a -> year - a }) } },
                label = { Text("Age") }, singleLine = true, isError = ageBad,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                profile.height_cm?.toString() ?: "", { v -> vm.update { it.copy(height_cm = v.toIntOrNull()) } },
                label = { Text("Height") }, suffix = { Text("cm") }, singleLine = true, isError = heightBad,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                profile.weight_kg?.toString() ?: "", { v -> vm.update { it.copy(weight_kg = v.toIntOrNull()) } },
                label = { Text("Weight") }, suffix = { Text("kg") }, singleLine = true, isError = weightBad,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f),
            )
        }
        if (ageBad || heightBad || weightBad) {
            Text(
                "That looks like a typo, double-check the highlighted field.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

// Full-width rows, not chips. This is the highest-consequence answer in the whole
// flow (it decides which later steps even exist), and a chip row made it look like
// a footnote. Settings keeps the compact chip selector: there the sports are
// already chosen and the screen is a summary, not a decision.
@Composable
internal fun StepSports(profile: TrainingProfile, vm: OnboardingViewModel) {
    StepColumn {
        SPORTS.forEach { sport ->
            SportRow(
                sport = sport,
                selected = profile.sports.contains(sport),
                onClick = { vm.update { it.copy(sports = it.sports.toggled(sport)) } },
            )
        }
    }
}

@Composable
private fun SportRow(sport: String, selected: Boolean, onClick: () -> Unit) {
    val icon = when (sport) {
        "run" -> Icons.AutoMirrored.Filled.DirectionsRun
        "ride" -> Icons.AutoMirrored.Filled.DirectionsBike
        "swim" -> Icons.Filled.Pool
        else -> Icons.Filled.FitnessCenter
    }
    Row(
        Modifier.fillMaxWidth().height(62.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primaryContainer
                else MaterialTheme.colorScheme.surfaceContainerHigh,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (selected) MaterialTheme.colorScheme.onPrimaryContainer
            else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(26.dp),
        )
        Text(
            sportLabel(sport),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer
            else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        if (selected) {
            Icon(
                Icons.Filled.CheckCircle,
                contentDescription = "Selected",
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

// One activity's own questions. The gym keeps the goal/level/split chips it has
// always had; the endurance sports ask the same thing with a line and a flag,
// because "how far" has a real answer between the named distances and "how fast"
// was never asked at all.
@Composable
internal fun StepActivity(sport: String, profile: TrainingProfile, vm: OnboardingViewModel) {
    if (EnduranceGoals.isEndurance(sport)) StepDistanceGoal(sport, profile, vm)
    else {
        StepColumn {
            SportGoalsLevel(
                sport = sport,
                goals = profile.goals_by_sport[sport].orEmpty(),
                level = profile.experience_by_sport[sport],
                splitStyle = profile.split_style,
                onGoalToggle = { g -> vm.update { it.copy(goals_by_sport = it.goals_by_sport.toggleIn(sport, g)) } },
                onLevel = { lvl -> vm.update { it.copy(experience_by_sport = it.experience_by_sport + (sport to lvl)) } },
                onSplit = { s -> vm.update { it.copy(split_style = if (s == "Auto") null else s) } },
            )
        }
    }
}

@Composable
private fun StepDistanceGoal(sport: String, profile: TrainingProfile, vm: OnboardingViewModel) {
    StepColumn {
        // seedIfUnset: the picker opens on a real, pre-selected target. Same
        // lesson as the week step, a pre-selection the athlete agrees with has
        // to leave something behind.
        EnduranceSportQuestions(sport, profile, seedIfUnset = true) { f -> vm.update(f) }
    }
}

@Composable
internal fun StepPerformance(profile: TrainingProfile, vm: OnboardingViewModel) {
    val intervalsConnected = (vm.intervalsStatus.collectAsStateSafe().value ?: "").startsWith("\u2713")
    StepColumn {
        PerformanceEditor(
            profile = profile,
            intervalsConnected = intervalsConnected,
            onUpdate = { t -> vm.update(t) },
        )
    }
}

@Composable
internal fun StepRace(profile: TrainingProfile, vm: OnboardingViewModel) {
    var showAdd by remember { mutableStateOf(false) }
    if (showAdd) AddGoalSheet(onClose = { showAdd = false }) { draft ->
        vm.addGoalRace(draft); showAdd = false
    }
    StepColumn {
        val goalDate = profile.goal_date?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        if (goalDate != null) {
            // The target event as a real card: date, phase countdown, target pace, and
            // clear Change/Remove actions instead of one ambiguous button.
            val phase = Periodization.phaseFor(goalDate, LocalDate.now())
            SectionCard {
                SectionLabel("YOUR PRIMARY EVENT")
                Text(
                    goalDate.format(DateTimeFormatter.ofPattern("EEE d MMM yyyy")),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    phase.weeksToGoal?.let { "${phase.name} phase · $it week${if (it == 1) "" else "s"} to go" }
                        ?: "Race day has passed",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                profile.target_pace?.let {
                    Text(
                        "Target pace $it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { showAdd = true }, modifier = Modifier.weight(1f)) { Text("Change event") }
                    TextButton(onClick = { vm.update { it.copy(goal_date = null, target_pace = null) } }) {
                        Text("Remove")
                    }
                }
            }
        } else {
            Text(
                "This is separate from what you are training toward. Add a dated event only if you want the plan to peak for it.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(onClick = { showAdd = true }, modifier = Modifier.fillMaxWidth()) {
                Text("Add target event")
            }
        }
    }
}

@Composable
internal fun StepAvailability(profile: TrainingProfile, vm: OnboardingViewModel) {
    StepColumn {
        // Answer first, questions underneath. Three taps set the whole week; the
        // chart above just shows what they produced, which is the part a chip row
        // genuinely cannot convey (which weekdays, and how the long day compares).
        WeekPreviewBars(profile.day_availability)
        // Frameless like every other onboarding step (see StepColumn): the same
        // Schedule/Session length grouping Settings uses, label-only, no cards.
        WeeklyAvailabilityEditor(profile.day_availability, grouped = false) { list ->
            vm.update { it.copy(day_availability = list) }
        }
    }
}

// Weekly effort + progression, on their own page: the chips price themselves
// from the week chosen on the previous step (Periodization.availabilityCeiling
// mirrors the server's clamp), so the numbers are always achievable and never
// TSS jargon, and the chart shows what the chosen effort does over the weeks.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun StepEffort(profile: TrainingProfile, vm: OnboardingViewModel) {
    StepColumn {
        val minutes = profile.day_availability.sumOf { it.max_minutes }
        val ceiling = Periodization.availabilityCeiling(minutes)
        if (ceiling == null) {
            Text(
                "Set your training days on the previous step first, this page sizes the effort options to the time you actually have.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            // Show the week these options are priced from. It is the only input
            // to the options below, and it was previously invisible: an athlete
            // who accepted the defaults never saw what got recorded.
            Text(
                "Your week: ${profile.day_availability.size} days, ${durationLabel(minutes)}. " +
                    "Priced from the time you actually have.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // Rows, not chips: each option carries what it MEANS ("80%, the usual
            // pick") next to its number, which is the part that lets a beginner
            // choose. A chip could only ever show the TSS, which is jargon.
            Periodization.Effort.entries.forEach { e ->
                val target = e.targetFor(ceiling)
                EffortRow(
                    label = e.label,
                    note = when (e) {
                        Periodization.Effort.LIGHT -> "60% of your ceiling, room to spare"
                        Periodization.Effort.MODERATE -> "80%, the usual pick"
                        Periodization.Effort.SOLID -> "95%, little room to spare"
                    },
                    tss = "~$target TSS",
                    selected = profile.weekly_tss_target == target,
                    onClick = { vm.update { it.copy(weekly_tss_target = target) } },
                )
            }
            Text(
                "The coach plans toward this. Change it anytime in Settings.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // Progression lives right under the effort choice so the chart can
            // show what THAT choice does over the weeks — one story, in order.
            PeriodizationControl(
                periodized = profile.periodized,
                onChange = { p -> vm.update { Periodization.configure(it, p) } },
                weeklyTssTarget = profile.weekly_tss_target,
            )
            PeriodizationNumbers(profile.weekly_tss_target, profile.periodized)
        }
    }
}

@Composable
private fun EffortRow(label: String, note: String, tss: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primaryContainer
                else MaterialTheme.colorScheme.surfaceContainerHigh,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                label,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer
                else MaterialTheme.colorScheme.onSurface,
            )
            Text(
                note,
                style = MaterialTheme.typography.bodySmall,
                color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            tss,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer
            else MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
internal fun StepEquipment(profile: TrainingProfile, vm: OnboardingViewModel) {
    StepGymScene(profile) {
        GymKitPicker(profile) { item ->
            vm.update { it.copy(equipment_list = toggledGymKit(it.equipment_list, item)) }
        }
    }
}

// --- The gym's four questions ----------------------------------------------
//
// Each one is the scene, then the question. The scene is the same composable on
// all four screens and keeps whatever the athlete has built so far, so it reads
// as one room being furnished rather than four unrelated forms: by the kit step
// the figure is standing in the gym the earlier answers described.

@Composable
private fun StepGymScene(profile: TrainingProfile, content: @Composable ColumnScope.() -> Unit) {
    StepColumn {
        GymSceneCard(profile.equipment_list, caption = gymSummary(profile).ifBlank { null })
        content()
    }
}

@Composable
internal fun StepGymGoals(profile: TrainingProfile, vm: OnboardingViewModel) {
    StepGymScene(profile) {
        GymGoalPicker(profile) { g ->
            vm.update { it.copy(goals_by_sport = it.goals_by_sport.toggleIn(GYM, g)) }
        }
    }
}

@Composable
internal fun StepGymLevel(profile: TrainingProfile, vm: OnboardingViewModel) {
    // The level step pre-selects rather than opening on nothing: a slider with
    // no value has to guess anyway, so it may as well show its guess and let the
    // athlete disagree with it. Same reasoning as the distance picker's seed.
    LaunchedEffect(Unit) {
        if (profile.experience_by_sport[GYM] == null) {
            gymLevels().firstOrNull()?.let { first ->
                vm.update { it.copy(experience_by_sport = it.experience_by_sport + (GYM to first)) }
            }
        }
    }
    StepGymScene(profile) {
        GymLevelPicker(profile) { lvl ->
            vm.update { it.copy(experience_by_sport = it.experience_by_sport + (GYM to lvl)) }
        }
    }
}

@Composable
internal fun StepGymSplit(profile: TrainingProfile, vm: OnboardingViewModel) {
    StepGymScene(profile) {
        GymSplitPicker(profile) { s ->
            vm.update { it.copy(split_style = if (s == "Auto") null else s) }
        }
    }
}

// Injuries / niggles the coach should train around. Quick-add chips append to
// the free text; tapping a present chip removes it.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun StepInjuries(profile: TrainingProfile, vm: OnboardingViewModel) {
    StepColumn {
        InjuryEditor(profile.injuries) { v -> vm.update { it.copy(injuries = v) } }
    }
}
