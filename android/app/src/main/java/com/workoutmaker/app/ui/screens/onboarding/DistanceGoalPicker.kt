package com.workoutmaker.app.ui.screens.onboarding

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.EnduranceGoals
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.ui.screens.settings.GOALS_BY_SPORT
import com.workoutmaker.app.ui.screens.settings.RACE_GOALS
import com.workoutmaker.app.ui.screens.settings.toggleIn
import com.workoutmaker.app.ui.components.rememberAnimationsEnabled
import kotlin.math.abs
import androidx.compose.ui.graphics.drawscope.translate
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

// ===========================================================================
// The distance goal, as a thing you drag rather than a chip you tick.
//
// A line, the classic distances standing on it as posts, a flag you drag to
// your target, and a figure that travels with the flag and moves at the pace
// you set. The pace is not decoration: it is half the goal ("42.2 km" and
// "42.2 km in 3:30" are different training plans), and coupling the cadence to
// it makes an abstract number something you can watch.
//
// All the arithmetic lives in data/EnduranceGoals.kt; this file is drawing.
// ===========================================================================

private val TRACK_HEIGHT = 172.dp
// Room for the first and last post labels AND for half the travelling handle,
// which is what actually sets this: the handle is centred on the value, so at
// 0% and 100% half of it hangs past the end of the line. Inset >= HANDLE_WIDTH/2
// is the invariant that keeps the flag on screen at both extremes.
private val TRACK_INSET = 48.dp
private val BASELINE_UP = 44.dp   // baseline height above the labels

/**
 * Everything an endurance sport is asked: how far, how fast, what for, and where
 * the athlete is starting from. Onboarding shows one of these per sport and
 * Settings shows the same thing behind that sport's row, so changing a goal in
 * Settings is the same act as setting it during onboarding, on the same control.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EnduranceSportQuestions(
    sport: String,
    profile: TrainingProfile,
    seedIfUnset: Boolean = false,
    onUpdate: ((TrainingProfile) -> TrainingProfile) -> Unit,
) {
    DistanceGoalEditor(sport, profile, seedIfUnset, onUpdate)

    // How far and how fast is not the whole question. A cyclist doing 40 km
    // might be chasing FTP or simply riding farther: the distance is the
    // training target, not a calendar event. Dated events are collected once,
    // separately, by StepRace after all sport goals are set.
    val intent = remember(sport) {
        ((GOALS_BY_SPORT[sport] ?: emptyList()) - EnduranceGoals.distanceOwnedGoals(sport)) - RACE_GOALS
    }
    if (intent.isNotEmpty()) {
        Text("What are you chasing?", style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val picked = profile.goals_by_sport[sport].orEmpty()
            intent.forEach { g ->
                FilterChip(
                    selected = picked.contains(g),
                    onClick = { onUpdate { it.copy(goals_by_sport = it.goals_by_sport.toggleIn(sport, g)) } },
                    label = { Text(g) },
                )
            }
        }
    }

    // Asked here rather than on a screen of its own: the distance says what you
    // want, the level says what you can currently absorb, and the coach needs
    // both to turn one into the other. Same slider the gym asks it with, since
    // experience is an ordered scale in every sport, not a set of equal chips.
    Text("What level are you?", style = MaterialTheme.typography.labelLarge)
    SportLevelPicker(sport, profile.experience_by_sport[sport]) { lvl ->
        onUpdate { it.copy(experience_by_sport = it.experience_by_sport + (sport to lvl)) }
    }
}

/**
 * The picker plus the profile writes around it: drag state, snapping, and the
 * goal-list merge, in one place so onboarding and Settings cannot drift apart.
 *
 * The state is local and the profile is written on release, because the flag
 * has to track the thumb at frame rate and a profile round-trip per drag frame
 * does not. [onUpdate] takes the same shape as both view models' update lambda.
 *
 * [seedIfUnset] is the difference between the two callers: onboarding pre-fills
 * a target so tapping through still leaves a real answer behind, while Settings
 * must not invent a distance goal for a sport the athlete never gave one, since
 * that would override their hand-picked goal chips the moment they looked.
 */
@Composable
internal fun DistanceGoalEditor(
    sport: String,
    profile: TrainingProfile,
    seedIfUnset: Boolean = false,
    onUpdate: ((TrainingProfile) -> TrainingProfile) -> Unit,
) {
    var fraction by remember(sport) {
        mutableFloatStateOf(
            profile.distance_goal_km[sport]?.let { EnduranceGoals.fractionForKm(sport, it) }
                ?: EnduranceGoals.defaultFraction(),
        )
    }
    var paceSec by remember(sport) {
        mutableIntStateOf(profile.goal_pace_sec_per_km[sport] ?: EnduranceGoals.defaultPaceSec(sport))
    }

    fun commit() {
        val km = EnduranceGoals.kmForFraction(sport, fraction)
        onUpdate { p ->
            if (p.distance_goal_km[sport] == km && p.goal_pace_sec_per_km[sport] == paceSec) {
                p
            } else {
                p.copy(
                    distance_goal_km = p.distance_goal_km + (sport to km),
                    goal_pace_sec_per_km = p.goal_pace_sec_per_km + (sport to paceSec),
                    goals_by_sport = p.goals_by_sport +
                        (sport to EnduranceGoals.withDistanceGoal(p.goals_by_sport[sport].orEmpty(), sport, km)),
                )
            }
        }
    }

    LaunchedEffect(sport) { if (seedIfUnset && profile.distance_goal_km[sport] == null) commit() }

    DistanceGoalPicker(
        sport = sport,
        fraction = fraction,
        paceSec = paceSec,
        onFraction = { fraction = it },
        onRelease = { fraction = EnduranceGoals.snapFraction(sport, fraction); commit() },
        onPace = { paceSec = EnduranceGoals.clampPace(sport, it); commit() },
    )
}

@Composable
internal fun DistanceGoalPicker(
    sport: String,
    fraction: Float,
    paceSec: Int,
    onFraction: (Float) -> Unit,
    onRelease: () -> Unit,
    onPace: (Int) -> Unit,
) {
    val posts = remember(sport) { EnduranceGoals.posts[sport].orEmpty() }
    val km = EnduranceGoals.kmForFraction(sport, fraction)
    val standingOn = EnduranceGoals.postAt(sport, fraction)

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        // The readout: how far, and what that distance is CALLED, which is the
        // reassurance that a dragged number is still a real event.
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                EnduranceGoals.formatKmValue(km),
                style = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                EnduranceGoals.kmUnit(km),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 6.dp, bottom = 5.dp),
            )
            Spacer(Modifier.weight(1f))
            Text(
                standingOn?.name ?: "custom distance",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                textAlign = TextAlign.End,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }

        DistanceTrack(sport, posts.map { it.label }, fraction, paceSec, standingOn != null, onFraction, onRelease)

        PacePanel(sport, paceSec, onPace)

        Row(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.28f))
                .padding(horizontal = 15.dp, vertical = 13.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                Icons.Filled.Schedule,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Text(
                "About ${EnduranceGoals.formatDuration(EnduranceGoals.estimateMinutes(km, paceSec))} " +
                    "at ${EnduranceGoals.formatPace(sport, paceSec)}. The figure moves at the pace you set.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun DistanceTrack(
    sport: String,
    labels: List<String>,
    fraction: Float,
    paceSec: Int,
    onPost: Boolean,
    onFraction: (Float) -> Unit,
    onRelease: () -> Unit,
) {
    val n = (labels.size - 1).coerceAtLeast(1)
    Box(Modifier.fillMaxWidth().height(TRACK_HEIGHT).padding(horizontal = TRACK_INSET)) {
        BoxWithConstraints(Modifier.fillMaxWidth().height(TRACK_HEIGHT)) {
            val span = maxWidth
            val spanPx = with(LocalDensity.current) { span.toPx() }

            // Pointer down anywhere on the line jumps the flag there and starts
            // the drag: aiming for a 42dp figure with a thumb is not a control.
            val gestures = Modifier
                .pointerInput(sport, spanPx) {
                    detectHorizontalDragGestures(
                        onDragStart = { p -> onFraction((p.x / spanPx).coerceIn(0f, 1f)) },
                        onDragEnd = onRelease,
                        onDragCancel = onRelease,
                    ) { change, _ ->
                        change.consume()
                        onFraction((change.position.x / spanPx).coerceIn(0f, 1f))
                    }
                }
                .pointerInput(sport, spanPx) {
                    detectTapGestures { p -> onFraction((p.x / spanPx).coerceIn(0f, 1f)); onRelease() }
                }

            Box(
                Modifier.fillMaxWidth().height(TRACK_HEIGHT).then(gestures).semantics {
                    contentDescription = "Distance goal, ${EnduranceGoals.formatKm(EnduranceGoals.kmForFraction(sport, fraction))}"
                },
            ) {
                // Baseline, and the part of it already covered.
                Box(
                    Modifier.align(Alignment.BottomStart).padding(bottom = BASELINE_UP)
                        .fillMaxWidth().height(2.dp).clip(RoundedCornerShape(50))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh),
                )
                Box(
                    Modifier.align(Alignment.BottomStart).padding(bottom = BASELINE_UP)
                        .width(span * fraction).height(2.dp).clip(RoundedCornerShape(50))
                        .background(MaterialTheme.colorScheme.primary),
                )

                labels.forEachIndexed { i, label ->
                    val f = i.toFloat() / n
                    val here = onPost && kotlin.math.abs(fraction - f) < 0.02f
                    val passed = f <= fraction + 0.001f
                    val tint = when {
                        here -> MaterialTheme.colorScheme.primary
                        passed -> MaterialTheme.colorScheme.onSurfaceVariant
                        else -> MaterialTheme.colorScheme.outlineVariant
                    }
                    Column(
                        Modifier.align(Alignment.BottomStart)
                            .offset(x = span * f - POST_WIDTH / 2)
                            .width(POST_WIDTH),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(9.dp),
                    ) {
                        Box(
                            Modifier.width(2.dp).height(if (here) 16.dp else 10.dp)
                                .clip(RoundedCornerShape(50)).background(tint),
                        )
                        Text(
                            label,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = if (here) FontWeight.Bold else FontWeight.Normal,
                            color = tint,
                            maxLines = 1,
                        )
                    }
                }

                // The travelling handle: the sport's figure, then the flag that
                // marks the spot. Centred on the fraction, like the design.
                Row(
                    Modifier.align(Alignment.BottomStart)
                        .padding(bottom = BASELINE_UP + 2.dp)
                        .offset(x = span * fraction - HANDLE_WIDTH / 2)
                        .width(HANDLE_WIDTH),
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    SportFigure(sport, paceSec)
                    GoalFlag()
                }
            }
        }
    }
}

private val POST_WIDTH = 44.dp
// The figure plus the flag beside it. Keep TRACK_INSET at or above half of
// this, or the handle overflows the screen at 100%.
private val HANDLE_WIDTH = 92.dp

@Composable
private fun PacePanel(sport: String, paceSec: Int, onPace: (Int) -> Unit) {
    val (leftLabel, rightLabel) = EnduranceGoals.paceEndLabels(sport)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                EnduranceGoals.paceCaption(sport),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            // Minus and plus follow the displayed number in every unit.
            StepperButton(Icons.Filled.Remove, "Decrease ${EnduranceGoals.paceCaption(sport).lowercase()}") { onPace(EnduranceGoals.stepPaceValue(sport, paceSec, increase = false)) }
            Row(
                Modifier.width(96.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.Bottom,
            ) {
                Text(
                    EnduranceGoals.paceValue(sport, paceSec),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    EnduranceGoals.paceUnit(sport),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp, bottom = 3.dp),
                )
            }
            StepperButton(Icons.Filled.Add, "Increase ${EnduranceGoals.paceCaption(sport).lowercase()}") { onPace(EnduranceGoals.stepPaceValue(sport, paceSec, increase = true)) }
        }
        Slider(
            value = EnduranceGoals.paceFraction(sport, paceSec),
            onValueChange = { onPace(EnduranceGoals.secForPaceFraction(sport, it)) },
            colors = SliderDefaults.colors(inactiveTrackColor = MaterialTheme.colorScheme.surfaceContainerLowest),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(leftLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            Text(rightLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun StepperButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    Box(
        Modifier.size(34.dp).clip(RoundedCornerShape(11.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            // clickable, NOT a raw pointerInput: pointerInput(Unit) never
            // restarts, so its gesture block held the first composition's
            // onClick forever. That lambda closed over the pace as it was on
            // first draw, so every press after the first re-applied one step
            // from the SAME starting value and the pace never moved again.
            .clickable(onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}

// --- The figures -----------------------------------------------------------
//
// Jointed stickmen, drawn procedurally: no assets, just trigonometry over one
// 0..2π phase per stride, pedal revolution or stroke.
//
// The body itself, its proportions and the primitives that draw it, lives in
// Stickman.kt and is shared with the lifter standing in the gym scene. What is
// here is only what each sport DOES with that body.
//
// Each figure is defined by the constraint its sport actually imposes:
//   run    the knee only ever flexes backwards, and the body rises twice per
//          stride (hence abs(sin)), which is what stops a runner looking like
//          it is skating
//   ride   the feet ARE the crank ends, and the knees are solved by IK to reach
//          them, exactly as the machine forces
//   swim   a freestyle windmill with a high elbow through the catch, a six-beat
//          flutter kick (three per arm cycle), body roll, bubbles and a splash
//          as the hand crosses the surface
//
// Cadence follows the chosen pace (EnduranceGoals.animationRate, capped at both
// ends). The phase is integrated per frame rather than driven by a keyframe
// animation, because an infiniteRepeatable is keyed on its duration and every
// pace change tore the loop back to its first frame.

/**
 * A 0..1 phase advanced once per frame, at one turn every [periodMs].
 *
 * Deliberately not an infiniteRepeatable: that is keyed on its duration, so
 * every pace change tore the animation back to its first frame. Here the period
 * is read fresh each frame and the phase simply carries on from where it was.
 */
@Composable
private fun rememberPhase(periodMs: Float): Float {
    val animate = rememberAnimationsEnabled()
    var phase by remember { mutableFloatStateOf(0f) }
    val period = rememberUpdatedState(periodMs)
    LaunchedEffect(animate) {
        if (!animate) {
            phase = 0f
            return@LaunchedEffect
        }
        var last = 0L
        while (true) {
            withFrameNanos { now ->
                if (last != 0L) {
                    val dtMs = (now - last) / 1_000_000f
                    phase = (phase + dtMs / period.value.coerceAtLeast(120f)) % 1f
                }
                last = now
            }
        }
    }
    return phase
}

// Sized against the track, not against the drawing: at 390dp wide with a 48dp
// inset either side there is ~294dp of line, and a handle wider than about a
// quarter of it stops reading as a marker and starts covering the posts it is
// meant to point at.
private val FIGURE_W = 68.dp
private val FIGURE_H = 62.dp

@Composable
private fun SportFigure(sport: String, paceSec: Int) {
    // Base cycle times per sport, stretched or squeezed by the chosen pace: a
    // pedal revolution is slower than a running stride, and a stroke slower still.
    val rate = EnduranceGoals.animationRate(sport, paceSec)
    val period = when (sport) {
        "ride" -> 900f
        "swim" -> 1500f
        else -> 700f
    } * rate
    val phase = rememberPhase(period) * TAU
    val accent = MaterialTheme.colorScheme.onSurface
    val figure = Modifier.size(FIGURE_W, FIGURE_H)
    when (sport) {
        "ride" -> CyclistStickman(phase, accent, MaterialTheme.colorScheme.primary, figure)
        "swim" -> SwimmerStickman(phase, accent, MaterialTheme.colorScheme.primary, figure)
        else -> RunnerStickman(phase, accent, figure)
    }
}

@Composable
private fun RunnerStickman(phase: Float, accent: Color, modifier: Modifier) {
    Canvas(modifier) {
        val h = size.height
        val w = size.width
        val sw = strokeFor(h)
        val cx = w * 0.5f

        // The body rises twice per stride, hence abs(sin).
        val bob = -h * 0.025f * abs(sin(phase))

        translate(top = bob) {
            val hip = Offset(cx - h * 0.02f, h * 0.55f)
            val neck = Offset(cx + h * 0.035f, h * 0.26f)
            val shoulder = Offset(cx + h * 0.03f, h * 0.30f)
            val head = Offset(cx + h * 0.08f, h * 0.165f)

            val thigh = h * 0.21f
            val shin = h * 0.20f
            val footLen = h * 0.07f
            val upperArm = h * 0.15f
            val foreArm = h * 0.14f

            fun leg(p: Float, alpha: Float) {
                val thighAngle = 0.95f * sin(p)
                // The knee only ever flexes backwards: shin angle < thigh angle.
                val bend = 0.12f + 1.25f * (0.5f - 0.5f * cos(p))
                val knee = hip.fromVertical(thighAngle, thigh)
                val ankle = knee.fromVertical(thighAngle - bend, shin)
                val toe = ankle.fromVertical(thighAngle - bend + 1.35f, footLen)
                limb(hip, knee, accent, sw, alpha)
                limb(knee, ankle, accent, sw, alpha)
                limb(ankle, toe, accent, sw * 0.85f, alpha)
            }

            fun arm(p: Float, alpha: Float) {
                val upperAngle = 0.75f * sin(p)
                val elbowBend = 1.45f + 0.35f * cos(p)
                val elbow = shoulder.fromVertical(upperAngle, upperArm)
                val hand = elbow.fromVertical(upperAngle + elbowBend, foreArm)
                limb(shoulder, elbow, accent, sw, alpha)
                limb(elbow, hand, accent, sw, alpha)
            }

            // Far side first and dimmed, so the figure reads as three-dimensional.
            leg(phase + Math.PI.toFloat(), FAR_SIDE_ALPHA)
            arm(phase, FAR_SIDE_ALPHA)

            limb(hip, neck, accent, sw)
            stickHead(head, h, accent)

            // Arms swing opposite the leg on the same side.
            leg(phase, 1f)
            arm(phase + Math.PI.toFloat(), 1f)
        }
    }
}

@Composable
private fun CyclistStickman(phase: Float, accent: Color, machine: Color, modifier: Modifier) {
    Canvas(modifier) {
        val h = size.height
        val w = size.width
        val sw = h * 0.033f
        // The bike is the app's accent and the rider is not, so the machine
        // reads as scenery and the body reads as the subject.
        val bike = machine.copy(alpha = 0.55f)

        val wheelR = h * 0.185f
        val hubY = h * 0.78f
        val rearHub = Offset(w * 0.23f, hubY)
        val frontHub = Offset(w * 0.79f, hubY)
        val bb = Offset(w * 0.50f, hubY - h * 0.03f) // bottom bracket
        val seat = Offset(w * 0.34f, hubY - h * 0.40f)
        val bar = Offset(w * 0.70f, hubY - h * 0.33f)

        // Wheels, with spokes turning at roughly gear ratio to the cranks.
        listOf(rearHub, frontHub).forEach { hub ->
            drawCircle(bike, wheelR, hub, style = Stroke(sw * 0.8f))
            repeat(3) { i ->
                val a = -phase * 2.2f + i * (TAU / 3f)
                limb(hub, hub.polar(a, wheelR), bike, sw * 0.45f, 0.6f)
            }
        }

        // Frame: chainstay, seatstay, seat tube, top tube, down tube, fork.
        listOf(
            bb to rearHub, seat to rearHub, bb to seat,
            seat to bar, bb to bar, bar to frontHub,
        ).forEach { (a, b) -> limb(a, b, bike, sw * 0.9f) }

        // Cranks and pedals. The feet are the crank ends.
        val crankR = h * 0.095f
        val pedalNear = bb.polar(phase, crankR)
        val pedalFar = bb.polar(phase + Math.PI.toFloat(), crankR)
        limb(bb, pedalNear, bike, sw * 0.7f)
        limb(bb, pedalFar, bike, sw * 0.7f)

        val hip = Offset(seat.x + h * 0.015f, seat.y - h * 0.02f)
        val shoulder = Offset(hip.x + h * 0.30f, hip.y - h * 0.20f) // hunched forward
        val head = Offset(shoulder.x + h * 0.125f, shoulder.y - h * 0.05f)
        val thigh = h * 0.24f
        val shin = h * 0.26f

        fun leg(pedal: Offset, alpha: Float) {
            val knee = solveKnee(hip, pedal, thigh, shin)
            limb(hip, knee, accent, sw, alpha)
            limb(knee, pedal, accent, sw, alpha)
            limb(pedal, Offset(pedal.x + h * 0.055f, pedal.y - h * 0.005f), accent, sw * 0.8f, alpha)
        }

        leg(pedalFar, 0.32f)

        limb(hip, shoulder, accent, sw)
        drawCircle(accent, h * 0.075f, head, style = Stroke(sw))

        // Arm reaching for the bar, elbow slightly dropped.
        val elbow = Offset(
            (shoulder.x + bar.x) / 2f + h * 0.015f,
            (shoulder.y + bar.y) / 2f + h * 0.035f,
        )
        limb(shoulder, elbow, accent, sw)
        limb(elbow, bar, accent, sw)

        leg(pedalNear, 1f)
    }
}

@Composable
private fun SwimmerStickman(phase: Float, accent: Color, water: Color, modifier: Modifier) {
    Canvas(modifier) {
        val h = size.height
        val w = size.width
        val sw = h * 0.034f
        val waterY = h * 0.60f

        // Rippling surface line.
        val ripple = Path().apply {
            moveTo(0f, waterY)
            var x = 0f
            while (x <= w) {
                lineTo(x, waterY + sin(x / w * 9f + phase * 1.4f) * h * 0.012f)
                x += w / 26f
            }
        }
        drawPath(ripple, water.copy(alpha = 0.35f), style = Stroke(sw * 0.6f))

        val roll = sin(phase) * h * 0.022f
        val shoulder = Offset(w * 0.62f, h * 0.54f + roll)
        val hip = Offset(w * 0.32f, h * 0.57f - roll * 0.4f)
        val head = Offset(w * 0.73f, h * 0.52f + roll * 0.7f)

        // Exhaled bubbles trailing off the head.
        repeat(3) { i ->
            val t = (phase / TAU + i * 0.33f) % 1f
            drawCircle(
                water.copy(alpha = 0.30f * (1f - t)),
                h * 0.014f * (1f - t * 0.4f),
                Offset(head.x + h * 0.06f + t * h * 0.14f, head.y - t * h * 0.10f),
            )
        }

        limb(hip, shoulder, accent, sw)
        drawCircle(accent, h * 0.075f, head, style = Stroke(sw))

        // Six-beat flutter kick: three kicks per arm cycle.
        fun leg(p: Float, alpha: Float) {
            val amp = h * 0.085f
            val knee = Offset(hip.x - h * 0.16f, hip.y + amp * sin(p))
            val foot = Offset(knee.x - h * 0.15f, knee.y + amp * 1.7f * sin(p - 0.9f))
            limb(hip, knee, accent, sw, alpha)
            limb(knee, foot, accent, sw * 0.85f, alpha)
        }
        leg(3f * phase + Math.PI.toFloat(), 0.32f)
        leg(3f * phase, 1f)

        // Freestyle windmill: 0 reaching forward, π/2 catch, π push back,
        // 3π/2 recovery over the top.
        fun arm(a: Float, alpha: Float) {
            val bend = 0.55f * sin(a) // high elbow through the catch
            val elbow = shoulder.polar(a, h * 0.19f)
            val hand = elbow.polar(a + bend, h * 0.18f)
            limb(shoulder, elbow, accent, sw, alpha)
            limb(elbow, hand, accent, sw, alpha)

            // Splash as the hand crosses the surface, entering or exiting.
            if (abs(hand.y - waterY) < h * 0.05f) {
                repeat(2) { i ->
                    drawCircle(
                        water.copy(alpha = 0.40f * alpha),
                        h * 0.011f,
                        Offset(hand.x + (i - 0.5f) * h * 0.05f, waterY - h * 0.035f),
                    )
                }
            }
        }
        arm(phase + Math.PI.toFloat(), 0.32f)
        arm(phase, 1f)
    }
}

/**
 * The marker itself: a pole on the line and a pennant that flutters. Not coupled
 * to pace, deliberately: the wind does not care how fast you are running.
 */
@Composable
private fun GoalFlag() {
    val phase = rememberPhase(1100f)
    val accent = MaterialTheme.colorScheme.primary
    Canvas(Modifier.size(22.dp, 54.dp)) {
        val u = size.width / 26f
        val flutter = 2f * cos(2.0 * Math.PI * phase).toFloat()
        drawLine(accent, Offset(4f * u, 58f * u), Offset(4f * u, 4f * u), strokeWidth = 2.4f * u, cap = StrokeCap.Round)
        val pennant = Path().apply {
            moveTo(5f * u, 5f * u)
            lineTo((21f + flutter) * u, 10f * u)
            lineTo(5f * u, 16f * u)
            close()
        }
        drawPath(pennant, accent)
    }
}
