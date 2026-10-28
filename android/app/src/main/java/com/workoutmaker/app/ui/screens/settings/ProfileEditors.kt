package com.workoutmaker.app.ui.screens.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.Role
import androidx.compose.material3.Text
import androidx.compose.material3.OutlinedTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import com.workoutmaker.app.data.TrainingProfile
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.DayAvailability
import com.workoutmaker.app.data.Periodization
import com.workoutmaker.app.data.ThemeMode
import com.workoutmaker.app.data.ThemePalette
import com.workoutmaker.app.ui.theme.palette
import com.workoutmaker.app.ui.theme.dynamicColorSupported
import com.workoutmaker.app.ui.theme.dynamicScheme
import androidx.compose.foundation.layout.ColumnScope
import com.workoutmaker.app.data.StartingLift
import com.workoutmaker.app.ui.theme.amberAccent
import com.workoutmaker.app.ui.components.GroupedSection
import com.workoutmaker.app.ui.components.SectionLabel
import com.workoutmaker.app.ui.components.SegmentedChoice
import com.workoutmaker.app.ui.components.SegmentedToggle

// ===========================================================================
// Stateless, ViewModel-agnostic profile editors. They take the current value
// plus change lambdas so BOTH onboarding and Settings drive them, keeping the
// two flows identical (the whole point of the redesign). Chips/labels follow
// the app's FilterChip + FlowRow idiom and theme-aware colours.
// ===========================================================================

// Activity-first goals: for ONE sport, its goal(s) + level, and (for the gym)
// its preferred split. The onboarding shows one of these per activity; Settings
// loops them for every selected sport.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SportGoalsLevel(
    sport: String,
    goals: List<String>,
    level: String?,
    splitStyle: String? = null,
    onGoalToggle: (String) -> Unit,
    onLevel: (String) -> Unit,
    onSplit: (String) -> Unit = {},
) {
    Text("${sportLabel(sport)} goal", style = MaterialTheme.typography.labelLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        (GOALS_BY_SPORT[sport] ?: emptyList()).forEach { g ->
            FilterChip(selected = goals.contains(g), onClick = { onGoalToggle(g) }, label = { Text(g) })
        }
    }
    Text("${sportLabel(sport)} level", style = MaterialTheme.typography.labelLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        (EXPERIENCE_BY_SPORT[sport] ?: LEVELS).forEach { lvl ->
            FilterChip(selected = level == lvl, onClick = { onLevel(lvl) }, label = { Text(lvl) })
        }
    }
    // The gym's own unique question: how to split the week. (Periodization
    // moved next to the effort chips on the availability step, where the
    // weekly target it visualizes is actually chosen.)
    if (sport == "strength") {
        Text("Preferred split", style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SPLIT_STYLES.forEach { s ->
                FilterChip(selected = (splitStyle ?: "Auto") == s, onClick = { onSplit(s) }, label = { Text(s) })
            }
        }
    }
}

// Periodization: a plain-language choice (Steady vs Periodized). The 8-week
// forecast chart it feeds is a SEPARATE composable (PeriodizationNumbers below)
// so Settings can card-box "Progression" and "8-week forecast" as two distinct
// sections; onboarding's Effort step just calls both in sequence, frameless.
@Composable
internal fun PeriodizationControl(
    periodized: Boolean,
    onChange: (Boolean) -> Unit,
    // The athlete's own weekly TSS target, when they have set one. Unused here
    // directly, kept for call-site symmetry with PeriodizationNumbers.
    weeklyTssTarget: Int? = null,
) {
    SegmentedToggle("Steady", "Periodized", right = periodized, onChange = onChange)
    Text(
        if (periodized) {
            "Builds up for a few weeks, then eases off so you absorb the work and come back stronger."
        } else {
            "Keeps a similar load every week."
        },
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

// The athlete's next 8 weeks as bars, in their OWN numbers — the same rules
// plan-week plans with (Periodization.projectedWeeks). Deload weeks are amber
// with a "rest" tag. showHeading is off in Settings (the card's own SectionLabel
// already says "8-week forecast") and on in onboarding, which has no other label.
@Composable
internal fun PeriodizationNumbers(
    weeklyTssTarget: Int?,
    periodized: Boolean,
    modifier: Modifier = Modifier,
    showHeading: Boolean = true,
) {
    val base = weeklyTssTarget ?: Periodization.DEFAULT_WEEKLY_TSS
    val weeks = remember(base, periodized) {
        if (periodized) Periodization.projectedWeeks(base)
        else (1..8).map { Periodization.Week(it, base, deload = false) }
    }
    val max = remember(weeks) { weeks.maxOf { it.tss }.toFloat() }
    val buildColor = MaterialTheme.colorScheme.primary
    val deloadColor = amberAccent()
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (showHeading) Text("Your next 8 weeks (TSS)", style = MaterialTheme.typography.labelLarge)
        Row(
            Modifier.fillMaxWidth().height(128.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            weeks.forEach { w ->
                val frac = (w.tss / max).coerceIn(0.06f, 1f)
                Column(
                    Modifier.weight(1f).fillMaxHeight(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.weight((1f - frac).coerceAtLeast(0.001f)))
                    Text(
                        "${w.tss}",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (w.deload) deloadColor else MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                    )
                    Box(
                        Modifier.fillMaxWidth().weight(frac)
                            .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
                            .background(if (w.deload) deloadColor.copy(alpha = 0.75f) else buildColor),
                    )
                    Text(
                        if (w.deload) "rest" else "W${w.number}",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (w.deload) deloadColor else muted,
                        maxLines = 1,
                    )
                }
            }
        }
        // The bars themselves already show flat-vs-wave; one short line is enough.
        Text(
            "Spread automatically for now, fine-tune any week in Settings.",
            style = MaterialTheme.typography.bodySmall, color = muted,
        )
    }
}

// Weekly availability, "few questions" model: days per week + one typical length
// + an optional longer day. The app spreads the week automatically (no day-by-day
// tedium, no time-of-day). The optional long day is pinned to a real weekday so
// the marathon long-run budget still reaches the planner.
//
// Rendered as two labeled groups (Schedule, Session length) via GroupedSection —
// boxed cards in Settings, frameless (label only) in onboarding, per [grouped].
// This one function stays the single owner of all six pieces of state, since
// push() combines all of them into one buildAvailability() call regardless of
// which group a given chip lives in.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun WeeklyAvailabilityEditor(
    availability: List<DayAvailability>,
    grouped: Boolean = true,
    onChange: (List<DayAvailability>) -> Unit,
) {
    // Seed the simple questions once from any existing per-day data.
    val seed = remember { availabilityToQuestions(availability) }
    var daysPerWeek by remember { mutableStateOf(seed.daysPerWeek) }
    var typical by remember { mutableStateOf(seed.typicalMin) }
    var longDays by remember { mutableStateOf(seed.longDays) }
    var longMin by remember { mutableStateOf(seed.longMin) }
    // Off by default: the app spreads the week automatically. An athlete with a
    // fixed schedule (e.g. always trains Mon/Wed/Fri) can pin the exact days instead.
    var pickDays by remember { mutableStateOf(false) }
    var chosenDays by remember { mutableStateOf<List<String>>(emptyList()) }
    // What the long-day toggle restores when switched back on. Without it the
    // switch did nothing: "on" re-assigned the (empty) list to itself, so
    // checked stayed false and the sub-questions never appeared. Saturday is
    // the fallback only until the athlete picks their own.
    var lastLongDays by remember { mutableStateOf(seed.longDays.ifEmpty { listOf("Sat") }) }

    fun push() = onChange(
        buildAvailability(daysPerWeek, typical, longDays, longMin, explicitDays = chosenDays.takeIf { pickDays }),
    )

    // Commit the seeded answers once, when we opened with nothing stored.
    // Every chip below renders as already-selected (4 days, 1h, "None"), but
    // push() only ran from a chip's onClick, so an athlete who agreed with the
    // defaults tapped nothing and left day_availability empty. That made the
    // next step ("How hard to go") compute a null ceiling and render an empty
    // page, and silently dropped the week from the review step and the server.
    // The pre-selection is a promise; this keeps it.
    LaunchedEffect(Unit) { if (availability.isEmpty()) push() }

    GroupedSection(grouped, "Schedule") {
        Text("Days per week", style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            DAYS_PER_WEEK.forEach { n ->
                FilterChip(
                    selected = daysPerWeek == n,
                    onClick = {
                        daysPerWeek = n
                        // A pick from before a lower count would otherwise sit above
                        // the new cap (reported: "5/4 selected") until re-tapped.
                        if (chosenDays.size > n) chosenDays = chosenDays.take(n)
                        push()
                    },
                    label = { Text("$n") },
                )
            }
        }
        Text("Which days?", style = MaterialTheme.typography.labelLarge)
        SegmentedToggle(
            "Spread automatically", "I'll pick", right = pickDays,
            onChange = { pickDays = it; push() },
        )
        if (pickDays) {
            Text(
                "${chosenDays.size}/$daysPerWeek selected",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                DAYS.forEach { d ->
                    FilterChip(
                        selected = d in chosenDays,
                        onClick = {
                            // Deselecting always works; selecting a new day past the
                            // count is a no-op instead of over-filling the pick
                            // (reported: could select 5 days when only 4 were asked for).
                            chosenDays = when {
                                d in chosenDays -> chosenDays - d
                                chosenDays.size < daysPerWeek -> chosenDays + d
                                else -> chosenDays
                            }
                            push()
                        },
                        label = { Text(d) },
                    )
                }
            }
        }
    }
    GroupedSection(grouped, "Session length") {
        Text("Typical length", style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TYPICAL_MINUTES.forEach { m ->
                FilterChip(selected = typical == m, onClick = { typical = m; push() }, label = { Text(durationLabel(m)) })
            }
        }
        // Plural under the hood (a triathlete can have two long days), but the
        // toggle only asks "any longer day at all?" — off clears the picks
        // entirely, same as the old "None" chip.
        ToggleRow(
            "Add a longer day", "Long run, long ride, etc.",
            checked = longDays.isNotEmpty(),
            onChange = { on ->
                if (on) {
                    longDays = lastLongDays
                } else {
                    lastLongDays = longDays // so flipping back on restores the picks
                    longDays = emptyList()
                }
                push()
            },
        )
        if (longDays.isNotEmpty()) {
            Text("Which day", style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                DAYS.forEach { d ->
                    FilterChip(
                        selected = d in longDays,
                        onClick = {
                            longDays = if (d in longDays) longDays - d else longDays + d
                            push()
                        },
                        label = { Text(d) },
                    )
                }
            }
            Text("How long", style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LONG_MINUTES.forEach { m ->
                    FilterChip(selected = longMin == m, onClick = { longMin = m; push() }, label = { Text(durationLabel(m)) })
                }
            }
        }
    }
}

// The equipment chip row lived here. It is GymKitPicker now: "Full gym" was one
// chip among nine, so the answer that makes the other eight moot looked exactly
// like the other eight.

// Theme palette + light/dark, shared by onboarding Appearance and Settings.
// Show, don't list: the mode is one pill track and every palette is a tile
// painted in its OWN colours, so the choice is made by looking rather than by
// reading six names next to identical radio buttons.
@Composable
internal fun AppearancePicker(
    themeMode: ThemeMode,
    palette: ThemePalette,
    onMode: (ThemeMode) -> Unit,
    onPalette: (ThemePalette) -> Unit,
    // Settings already has its own detail header; onboarding needs the label.
    label: String? = "Make it yours",
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (label != null) SectionLabel(label)
        // Short labels: "Follow system" does not fit a third of a pill track.
        val modes = listOf(ThemeMode.DARK to "Dark", ThemeMode.LIGHT to "Light", ThemeMode.SYSTEM to "System")
        SegmentedChoice(
            labels = modes.map { it.second },
            selectedIndex = modes.indexOfFirst { it.first == themeMode }.coerceAtLeast(0),
            onSelect = { onMode(modes[it].first) },
        )
        val choices = ThemePalette.entries.filter { it != ThemePalette.DYNAMIC || dynamicColorSupported }
        // DYNAMIC is the default but renders as Serene below Android 12, where it
        // is also not offered — so highlight the tile the app is actually showing.
        val shown = if (palette == ThemePalette.DYNAMIC && !dynamicColorSupported) ThemePalette.SERENE else palette
        // Fixed 3-up grid built from chunks: the tiles must share a row width,
        // and FlowRow would leave a ragged last row of full-width cards.
        choices.chunked(PALETTE_COLUMNS).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { p ->
                    PaletteTile(p, selected = shown == p, onClick = { onPalette(p) }, modifier = Modifier.weight(1f))
                }
                // Keep a short last row's tiles the same size as the ones above.
                repeat(PALETTE_COLUMNS - row.size) { Box(Modifier.weight(1f)) }
            }
        }
    }
}

private const val PALETTE_COLUMNS = 3

// One palette, painted in its own colours: tile = primaryContainer, name =
// onPrimaryContainer, and three dots (primary / secondary / surface) so a palette
// is judged by the trio it actually paints the app with, not by one accent.
// Selected is a ring in that palette's primary, so the tile still reads as itself
// and not as the currently active theme.
@Composable
internal fun PaletteTile(
    p: ThemePalette,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Preview the mode the app is actually rendering right now (a light-mode
    // preview of a dark scheme is a lie about what tapping does).
    val previewDark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    val scheme = if (p == ThemePalette.DYNAMIC && dynamicColorSupported) {
        dynamicScheme(LocalContext.current, darkTheme = previewDark)
    } else {
        p.palette().let { if (previewDark) it.dark else it.light }
    }
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier
            .clip(shape)
            .background(scheme.primaryContainer)
            .border(
                width = if (selected) 2.dp else 1.dp,
                color = if (selected) scheme.primary else scheme.outlineVariant,
                shape = shape,
            )
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf(scheme.primary, scheme.secondary, scheme.surface).forEach { c ->
                Box(
                    Modifier.size(14.dp).clip(CircleShape).background(c)
                        .border(1.dp, scheme.onPrimaryContainer.copy(alpha = 0.2f), CircleShape),
                )
            }
        }
        Text(
            p.label,
            style = MaterialTheme.typography.labelMedium,
            color = scheme.onPrimaryContainer,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            maxLines = 2,
        )
    }
}

// --- Availability helpers (few-questions <-> per-day list) ------------------

internal data class AvailQuestions(
    val daysPerWeek: Int,
    val typicalMin: Int,
    // Every day whose budget clearly exceeds the typical one (long run day,
    // long ride day, ...). Plural: a triathlete's weekend has two long days.
    val longDays: List<String>,
    val longMin: Int,
)

// Reverse-map an existing per-day list back to the simple questions so the
// editor opens pre-filled (for existing accounts / re-editing).
internal fun availabilityToQuestions(availability: List<DayAvailability>): AvailQuestions {
    if (availability.isEmpty()) return AvailQuestions(daysPerWeek = 4, typicalMin = 60, longDays = emptyList(), longMin = 120)
    val maxMin = availability.maxOf { it.max_minutes }
    val nonLong = availability.filter { it.max_minutes < maxMin }
    val basis = (if (nonLong.isNotEmpty()) nonLong else availability).map { it.max_minutes }.sorted()
    val typical = nearestChip(basis[(basis.size - 1) / 2], TYPICAL_MINUTES)
    // Long days are every day clearly over the typical budget (not just one).
    val longEntries = availability.filter { it.max_minutes > typical }
    return AvailQuestions(
        daysPerWeek = availability.size.coerceIn(DAYS_PER_WEEK.first(), DAYS_PER_WEEK.last()),
        typicalMin = typical,
        longDays = longEntries.map { it.day },
        longMin = longEntries.maxOfOrNull { nearestChip(it.max_minutes, LONG_MINUTES) } ?: 120,
    )
}

// Build the per-day list from the simple answers: spread N days over the week
// (or use the athlete's own picks, once there are exactly N of them), force the
// long day in (keeping the count), and cap each day.
internal fun buildAvailability(
    daysPerWeek: Int,
    typical: Int,
    longDays: List<String>,
    longMin: Int,
    explicitDays: List<String>? = null,
): List<DayAvailability> {
    // A half-finished pick (wrong count, e.g. mid-selection or a stale count
    // change) falls back to the auto-spread pattern rather than reaching the
    // server under-filled.
    val base = explicitDays?.takeIf { it.size == daysPerWeek }
        ?: (DAY_PATTERNS[daysPerWeek] ?: DAY_PATTERNS.getValue(4))
    // Every long day IS a training day; the remaining slots fill from the base
    // pattern's regular days in order. (The naive "swap the last base day"
    // version could evict one long day to make room for another.)
    val longs = longDays.distinct().take(daysPerWeek)
    val regulars = base.filterNot { it in longs }.take((daysPerWeek - longs.size).coerceAtLeast(0))
    return (regulars + longs).sortedBy { DAYS.indexOf(it) }.map { d ->
        DayAvailability(day = d, max_minutes = if (d in longs) longMin else typical)
    }
}

private fun nearestChip(v: Int, options: List<Int>): Int =
    options.minByOrNull { kotlin.math.abs(it - v) } ?: v

// Add/remove an item from a multi-select list.
internal fun List<String>.toggled(item: String): List<String> =
    if (contains(item)) this - item else this + item

// Add/remove an item from a per-key multi-select map (per-activity goals).
internal fun Map<String, List<String>>.toggleIn(key: String, item: String): Map<String, List<String>> {
    val cur = this[key].orEmpty()
    return this + (key to (if (cur.contains(item)) cur - item else cur + item))
}

// "45m" / "1h" / "1h30" / "2h" / "3h" for the availability chips.
internal fun durationLabel(min: Int): String = when {
    min < 60 -> "${min}m"
    min % 60 == 0 -> "${min / 60}h"
    else -> "${min / 60}h${min % 60}"
}

// --- "Your numbers" ----------------------------------------------------------
// Optional performance anchors, one compact section per selected sport. These
// are the inputs generation was starving for: threshold pace (run zones), FTP
// (ride power), CSS (swim pace), top sets (strength progression floor), LTHR
// (HR zones). Every field skippable; the copy sells why it's worth 30 seconds.

/** "mm:ss" or "h:mm:ss" → seconds, null when unparseable. */
internal fun parseTimeSeconds(text: String): Int? {
    val parts = text.trim().split(":").map { it.toIntOrNull() ?: return null }
    return when (parts.size) {
        2 -> parts[0] * 60 + parts[1]
        3 -> parts[0] * 3600 + parts[1] * 60 + parts[2]
        else -> null
    }
}

private fun formatPace(secondsPerKm: Int): String = "%d:%02d".format(secondsPerKm / 60, secondsPerKm % 60)

/**
 * Threshold pace from a recent race result. Standard approximations: threshold
 * (the pace you can hold ~1h) is a touch slower than 5K race pace, roughly 10K
 * race pace, and a touch faster than half-marathon pace.
 */
internal fun thresholdPaceFromRace(distanceKm: Double, timeSeconds: Int): String? {
    if (timeSeconds <= 0 || distanceKm <= 0) return null
    val racePaceSecPerKm = timeSeconds / distanceKm
    val factor = when {
        distanceKm <= 6.0 -> 1.05  // 5K: threshold ~5% slower
        distanceKm <= 12.0 -> 1.00 // 10K: threshold ~= race pace
        else -> 0.97               // half: threshold ~3% faster
    }
    val sec = (racePaceSecPerKm * factor).toInt()
    // Sanity: 2:30-12:00 /km covers every plausible runner; outside is a typo.
    return if (sec in 150..720) formatPace(sec) else null
}

private val RACE_DISTANCES = listOf("5K" to 5.0, "10K" to 10.0, "Half" to 21.0975)

@Composable
private fun PerfSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        content()
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PerformanceEditor(
    profile: TrainingProfile,
    intervalsConnected: Boolean,
    onUpdate: ((TrainingProfile) -> TrainingProfile) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            if (intervalsConnected) {
                "Intervals.icu is connected, so your zones and thresholds sync automatically. Anything you add here fills the gaps."
            } else {
                "All optional, but every number here makes your workouts noticeably more accurate. Skip anything you don't know."
            },
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (profile.sports.contains("run")) {
            var raceDist by remember { mutableStateOf<String?>(null) }
            var raceTime by remember { mutableStateOf("") }
            PerfSection("Running") {
                Text(
                    "A recent race result sets your training paces.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    RACE_DISTANCES.forEach { (label, _) ->
                        FilterChip(
                            selected = raceDist == label,
                            onClick = {
                                raceDist = if (raceDist == label) null else label
                                val km = RACE_DISTANCES.firstOrNull { it.first == raceDist }?.second
                                val secs = parseTimeSeconds(raceTime)
                                val pace = if (km != null && secs != null) thresholdPaceFromRace(km, secs) else null
                                onUpdate { it.copy(threshold_pace_per_km = pace ?: it.threshold_pace_per_km) }
                            },
                            label = { Text(label) },
                        )
                    }
                }
                OutlinedTextField(
                    raceTime,
                    { v ->
                        raceTime = v
                        val km = RACE_DISTANCES.firstOrNull { it.first == raceDist }?.second
                        val secs = parseTimeSeconds(v)
                        if (km != null && secs != null) {
                            thresholdPaceFromRace(km, secs)?.let { pace ->
                                onUpdate { it.copy(threshold_pace_per_km = pace) }
                            }
                        }
                    },
                    label = { Text("Finish time") },
                    placeholder = { Text(if (raceDist == "Half") "1:45:00" else "25:30") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                    supportingText = profile.threshold_pace_per_km?.let {
                        { Text("Threshold pace ~$it /km") }
                    },
                )
            }
        }
        if (profile.sports.contains("ride")) {
            PerfSection("Cycling") {
                OutlinedTextField(
                    profile.ftp?.toString() ?: "",
                    { v -> onUpdate { it.copy(ftp = v.toIntOrNull()?.takeIf { w -> w in 50..600 }) } },
                    label = { Text("FTP") }, suffix = { Text("watts") }, singleLine = true,
                    placeholder = { Text("Leave empty if unsure") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (profile.sports.contains("swim")) {
            PerfSection("Swimming") {
                OutlinedTextField(
                    profile.css_per_100m ?: "",
                    { v -> onUpdate { it.copy(css_per_100m = v.ifBlank { null }) } },
                    label = { Text("Comfortable 100m pace") }, placeholder = { Text("1:55") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("The pace you could hold for a steady 400m") },
                )
            }
        }
        if (profile.sports.contains("strength")) {
            PerfSection("Strength") {
                Text(
                    "Your current top set per lift. Workouts use these together with your logged sets to choose exercises, weights and reps.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                listOf("Back Squat", "Barbell Bench Press", "Deadlift").forEach { lift ->
                    StartingLiftRow(lift, profile, onUpdate)
                }
            }
        }
        if (!intervalsConnected && (profile.sports.contains("run") || profile.sports.contains("ride"))) {
            PerfSection("Heart rate") {
                OutlinedTextField(
                    profile.lthr?.toString() ?: "",
                    { v -> onUpdate { it.copy(lthr = v.toIntOrNull()?.takeIf { h -> h in 120..210 }) } },
                    label = { Text("Threshold heart rate") }, suffix = { Text("bpm") }, singleLine = true,
                    placeholder = { Text("The HR you can hold ~1 hour") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("Sets your HR zones. Without it, zones are estimated from your age.") },
                )
            }
        }
    }
}

@Composable
internal fun StartingLiftRow(lift: String, profile: TrainingProfile, onUpdate: ((TrainingProfile) -> TrainingProfile) -> Unit) {
    val current = profile.starting_lifts.firstOrNull { it.exercise == lift }
    fun write(weight: Double?, reps: Int?) {
        onUpdate { p ->
            val rest = p.starting_lifts.filterNot { it.exercise == lift }
            val w = weight ?: current?.weight_kg
            val r = reps ?: current?.reps
            p.copy(
                starting_lifts = if (w != null && w > 0) {
                    rest + StartingLift(lift, w, r ?: 5)
                } else rest,
            )
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            lift.removePrefix("Barbell "),
            Modifier.weight(1.2f),
            style = MaterialTheme.typography.bodyMedium,
        )
        // NumberField, not a raw OutlinedTextField: bound straight to the parsed
        // Double, "82." rendered back as "82" and the decimal point could never
        // be typed at all.
        NumberField(
            current?.weight_kg?.let { if (it % 1.0 == 0.0) it.toInt().toString() else it.toString() } ?: "",
            { v -> write(v.toDoubleOrNull(), null) },
            label = "kg", decimal = true, modifier = Modifier.weight(1f),
        )
        NumberField(
            current?.reps?.toString() ?: "",
            { v -> write(null, v.toIntOrNull()) },
            label = "reps", modifier = Modifier.weight(1f),
        )
    }
}

