package com.workoutmaker.app.ui.screens.onboarding

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.ui.collectAsStateSafe
import androidx.compose.material3.AlertDialog
import androidx.compose.ui.platform.LocalContext
import com.workoutmaker.app.notify.vibrateCelebrate
import com.workoutmaker.app.ui.components.BreathingBackdrop
import com.workoutmaker.app.ui.components.Confetti
import com.workoutmaker.app.ui.components.rememberAnimationsEnabled
import com.workoutmaker.app.ui.screens.settings.SPORTS
import com.workoutmaker.app.ui.screens.settings.shouldOfferTargetEvent
import com.workoutmaker.app.ui.screens.settings.sportLabel

// The onboarding steps, in order. RACE and the gym block are conditional; the
// rest always show. Conditional steps come AFTER the step that decides them
// (SPORTS), so the visible-step index of the current screen never shifts under
// the user.
// GYM_* are the gym's four questions, which used to be one screen of twenty-two
// chips (goals, level and split together, with the kit stranded on its own step
// much later). One question per screen, and the kit joins them so the four read
// as one conversation about the gym instead of two separated by the whole week.
internal enum class ObStep { WELCOME, APPEARANCE, PERSONAL, SPORTS, ACTIVITY, GYM_GOALS, GYM_LEVEL, GYM_SPLIT, PERFORMANCE, RACE, AVAILABILITY, EFFORT, EQUIPMENT, INJURIES, COACH, CONNECT, PERMISSIONS, REVIEW }

// A step, plus (for ACTIVITY) which sport it asks about.
internal data class StepSpec(val kind: ObStep, val sport: String? = null)

internal fun visibleSteps(p: TrainingProfile): List<StepSpec> = buildList {
    add(StepSpec(ObStep.WELCOME)) // includes the theme picker (was its own step)
    add(StepSpec(ObStep.PERSONAL))
    add(StepSpec(ObStep.SPORTS))
    // Import before asking: a connected watch answers the zones/thresholds
    // questions the later steps would otherwise pose, so CONNECT comes early.
    add(StepSpec(ObStep.CONNECT))
    // One guided step per selected activity. The endurance sports ask "how far"
    // on one screen; the gym asks four questions, because its answers are four
    // unrelated things (what for, how experienced, what shape, what kit) and
    // stacking them made the busiest screen in the app.
    SPORTS.filter { p.sports.contains(it) }.forEach { sport ->
        if (sport == GYM) {
            add(StepSpec(ObStep.GYM_GOALS))
            add(StepSpec(ObStep.GYM_LEVEL))
            add(StepSpec(ObStep.GYM_SPLIT))
            add(StepSpec(ObStep.EQUIPMENT))
        } else {
            add(StepSpec(ObStep.ACTIVITY, sport))
        }
    }
    // "Your numbers": optional performance anchors, one section per sport.
    if (p.sports.isNotEmpty()) add(StepSpec(ObStep.PERFORMANCE))
    // A target event is optional and separate from the training goal above.
    // Every endurance athlete may have one; it must not be gated behind
    // choosing a race-shaped goal label first.
    if (shouldOfferTargetEvent(p)) add(StepSpec(ObStep.RACE))
    add(StepSpec(ObStep.AVAILABILITY))
    // Effort + progression get their own page: they price themselves from the
    // week just chosen, and burying them under the day picker hid the choice.
    add(StepSpec(ObStep.EFFORT))
    add(StepSpec(ObStep.INJURIES))
    add(StepSpec(ObStep.COACH))
    // Permissions last, right before Review: by here the user has seen what the
    // readiness score, the planner and the rest timer actually do, so "why does
    // it want my calendar" answers itself instead of being a cold ask up front.
    add(StepSpec(ObStep.PERMISSIONS))
    add(StepSpec(ObStep.REVIEW))
}

// Each step asks ONE question, in the coach's own voice, and answers "why are
// you asking" underneath it. This replaced a chrome-level "STEP 4 OF 15" plus a
// filing-cabinet title ("Your week"): the counter only ever told the athlete how
// much was left, and 15 is a number that makes people quit.
//
// WELCOME and REVIEW are absent on purpose — they draw their own centred hero.
internal fun stepHeadline(spec: StepSpec): Pair<String, String?>? = when (spec.kind) {
    ObStep.WELCOME, ObStep.REVIEW -> null
    ObStep.APPEARANCE -> "Make it yours" to "Pick the look you want to open every morning."
    ObStep.PERSONAL -> "Who am I coaching?" to
        "This tunes load, recovery and intensity to you. All optional, but it helps me calibrate."
    ObStep.SPORTS -> "What do you actually do?" to
        "Pick all of them. Only what you pick gets scheduled, and each one adds its own questions."
    // The endurance sports ask "how far", on a line you drag; the gym keeps the
    // goal chips, because a bench press has no distance.
    ObStep.ACTIVITY -> when (spec.sport) {
        "run" -> "How far are you running?" to
            "Drag the flag along the line. Let go near a post to lock onto a classic distance."
        "ride" -> "How far are you riding?" to
            "Drag the flag along the line. Let go near a post to lock onto a classic distance."
        "swim" -> "How far are you swimming?" to
            "Drag the flag along the line. Let go near a post to lock onto a classic distance."
        else -> (spec.sport?.let { "${sportLabel(it)}: what are you chasing?" } ?: "What are you chasing?") to
            "Your goal and level decide what the sessions are FOR, not just how long they are."
    }
    ObStep.GYM_GOALS -> "What are you chasing?" to
        "Pick as many as fit. This decides what the sessions are for, not just how long they run."
    ObStep.GYM_LEVEL -> "How long have you been lifting?" to
        "Slide to where you are. It sets the starting loads and how fast I add weight."
    ObStep.GYM_SPLIT -> "How should the week break up?" to
        "Leave it to me unless you already train a particular way."
    ObStep.PERFORMANCE -> "Your numbers" to
        "Optional anchors. Every one you fill makes the prescribed paces and weights sharper."
    ObStep.RACE -> "Do you have a target event?" to
        "Optional. Your training goal still guides the plan; an event date adds base, build, peak and taper."
    ObStep.AVAILABILITY -> "Which days are yours?" to
        "Answer the three questions and the chart shows the week you just described."
    ObStep.EFFORT -> "How hard should your weeks be?" to null
    ObStep.EQUIPMENT -> "What can you train with?" to
        "I only prescribe lifts your kit actually supports."
    ObStep.INJURIES -> "Anything I should train around?" to
        "Injuries, niggles or areas to protect. I avoid loading these and pick safer alternatives."
    ObStep.COACH -> "Give me a brain to think with." to
        "Pro runs on hosted AI with nothing to configure, or bring your own key and pay the provider directly."
    ObStep.CONNECT -> "Connect your watch" to
        "Optional, and the biggest single upgrade: a connected watch answers the fitness questions the next steps would otherwise ask you."
    ObStep.PERMISSIONS -> "What may I use?" to
        "Asked last, never silently, and every one of these is refusable."
}

/** The step's question, and the one line that justifies asking it. */
@Composable
internal fun StepHeader(title: String, subtitle: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 4.dp)) {
        Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        if (subtitle != null) {
            Text(
                subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OnboardingScreen(vm: OnboardingViewModel = hiltViewModel()) {
    val stepIndex by vm.step.collectAsStateSafe()
    val profile by vm.profile.collectAsStateSafe()
    val busy by vm.busy.collectAsStateSafe()
    val finishStatus by vm.finishStatus.collectAsStateSafe()

    val celebrating by vm.celebrating.collectAsStateSafe()

    // Target-event eligibility depends only on the selected sports. The event
    // itself is optional, not a second consequence of selecting a goal/distance.
    val steps = remember(profile.sports) { visibleSteps(profile) }
    val idx = stepIndex.coerceIn(0, steps.lastIndex)
    val current = steps[idx]
    val animationsOn = rememberAnimationsEnabled()

    Box(Modifier.fillMaxSize()) {
        BreathingBackdrop(Modifier.fillMaxSize(), intensity = 0.6f)
        // Onboarding renders OUTSIDE MainScaffold (see AuthGate.OnboardingGate), so it
        // inherits none of the Scaffold's window insets — and targetSdk 35 forces
        // edge-to-edge. Inset the content only; the backdrop above stays full-bleed.
        // Fixed header and fixed nav buttons; only the step content scrolls.
        // Back/Next stop drifting with each step's height, and the thumb always
        // finds them in the same place.
        var confirmSkip by remember { mutableStateOf(false) }
        if (confirmSkip) {
            AlertDialog(
                onDismissRequest = { confirmSkip = false },
                title = { Text("Skip setup?") },
                text = {
                    Text(
                        "Without your sports, week and goals, the coach plans from generic " +
                            "defaults instead of you. You can finish setup anytime in Settings.",
                    )
                },
                confirmButton = {
                    TextButton(onClick = { confirmSkip = false; vm.finish() }) { Text("Skip anyway") }
                },
                dismissButton = {
                    TextButton(onClick = { confirmSkip = false }) { Text("Keep going") }
                },
            )
        }
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp)) {
            // One quiet chrome row: where you can go back, how far along you are,
            // and the way out. The progress bar is the ONLY progress signal (see
            // stepHeadline) and it grows as the step list itself grows.
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { vm.goBack() }, enabled = idx > 0) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                        tint = if (idx > 0) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.outlineVariant
                        },
                    )
                }
                val progress by animateFloatAsState(
                    targetValue = ((idx + 1).toFloat() / steps.size).coerceIn(0f, 1f),
                    animationSpec = tween(300),
                    label = "onboardingProgress",
                )
                Box(
                    Modifier.weight(1f).padding(horizontal = 6.dp).height(4.dp)
                        .clip(RoundedCornerShape(50))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh),
                ) {
                    Box(
                        Modifier.fillMaxWidth(progress).fillMaxHeight()
                            .clip(RoundedCornerShape(50))
                            .background(MaterialTheme.colorScheme.primary),
                    )
                }
                if (current.kind != ObStep.REVIEW) {
                    TextButton(onClick = { confirmSkip = true }) {
                        Text("Later", style = MaterialTheme.typography.bodySmall)
                    }
                } else {
                    Spacer(Modifier.width(12.dp))
                }
            }
            Spacer(Modifier.height(6.dp))

            // Directional slide between steps, in the app's tween(240) language.
            // Each step scrolls independently (state is per AnimatedContent slot,
            // so a new step always starts at the top).
            AnimatedContent(
                targetState = idx,
                modifier = Modifier.weight(1f),
                transitionSpec = {
                    val forward = targetState > initialState
                    val enter = slideInHorizontally(tween(240)) { if (forward) it / 3 else -it / 3 } + fadeIn(tween(240))
                    val exit = slideOutHorizontally(tween(240)) { if (forward) -it / 3 else it / 3 } + fadeOut(tween(150))
                    enter.togetherWith(exit)
                },
                label = "onboardingStep",
            ) { i ->
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    val spec = steps.getOrElse(i) { steps.last() }
                    stepHeadline(spec)?.let { (title, subtitle) ->
                        StepHeader(title, subtitle)
                        Spacer(Modifier.height(14.dp))
                    }
                    when (spec.kind) {
                        ObStep.WELCOME -> StepWelcome(vm)
                        ObStep.APPEARANCE -> StepAppearance(vm)
                        ObStep.PERSONAL -> StepPersonal(profile, vm)
                        ObStep.SPORTS -> StepSports(profile, vm)
                        ObStep.ACTIVITY -> StepActivity(spec.sport ?: GYM, profile, vm)
                        ObStep.GYM_GOALS -> StepGymGoals(profile, vm)
                        ObStep.GYM_LEVEL -> StepGymLevel(profile, vm)
                        ObStep.GYM_SPLIT -> StepGymSplit(profile, vm)
                        ObStep.PERFORMANCE -> StepPerformance(profile, vm)
                        ObStep.RACE -> StepRace(profile, vm)
                        ObStep.AVAILABILITY -> StepAvailability(profile, vm)
                        ObStep.EFFORT -> StepEffort(profile, vm)
                        ObStep.EQUIPMENT -> StepEquipment(profile, vm)
                        ObStep.INJURIES -> StepInjuries(profile, vm)
                        ObStep.COACH -> StepKey(vm)
                        ObStep.CONNECT -> StepConnect(vm)
                        ObStep.PERMISSIONS -> StepPermissions(vm)
                        ObStep.REVIEW -> StepReview(profile, vm)
                    }
                    Spacer16()
                }
            }

            finishStatus?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.padding(vertical = 4.dp),
                )
            }
            // One full-width action, always in the same place, labelled for what
            // it actually does here. Back moved into the chrome arrow above, so
            // the thumb never has to choose between two same-sized buttons.
            Button(
                onClick = {
                    if (current.kind == ObStep.REVIEW) vm.finish(celebrate = animationsOn)
                    else vm.goNext(steps.lastIndex)
                },
                enabled = current.kind != ObStep.REVIEW || !busy,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp).height(52.dp),
            ) {
                Text(
                    when {
                        current.kind == ObStep.REVIEW && busy -> "Saving…"
                        current.kind == ObStep.REVIEW -> "Finish"
                        current.kind == ObStep.WELCOME -> "Let's go"
                        else -> "Continue"
                    },
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        // Above the content and full-bleed, so it falls past the insets too.
        // The buzz belongs to the celebration moment, not the drawing: with
        // animations off, finish() never celebrates, so neither fires.
        val ctx = LocalContext.current
        LaunchedEffect(celebrating) {
            if (celebrating) vibrateCelebrate(ctx)
        }
        Confetti(playing = celebrating)
    }
}

@Composable internal fun Spacer16() = Spacer(Modifier.padding(8.dp))

// Frameless step body: content flows on the backdrop with steady spacing (no
// boxing card, no repeated title — the header above already names the step).
@Composable
internal fun StepColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp), content = content)
}

// --- Steps -----------------------------------------------------------------























// --- Coach AI (Pro / bring-your-own key) + Intervals, unchanged from before -
