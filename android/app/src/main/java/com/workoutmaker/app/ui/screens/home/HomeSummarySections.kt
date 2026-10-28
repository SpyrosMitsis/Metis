package com.workoutmaker.app.ui.screens.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.ui.components.ChipRow
import com.workoutmaker.app.ui.components.InsetStat
import com.workoutmaker.app.ui.components.QuoteBlock
import com.workoutmaker.app.ui.components.SectionCard
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.workoutmaker.app.data.GoalProgress
import com.workoutmaker.app.data.SessionDebrief
import com.workoutmaker.app.data.WeekReview
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import com.workoutmaker.app.ui.screens.settings.DAYS
import com.workoutmaker.app.ui.screens.settings.sportLabel

// Compact planned-vs-actual card: the analysis label as the verdict headline,
// the coach's note underneath, whole card tappable into the activity detail.
@Composable
internal fun SessionDebriefCard(
    modifier: Modifier,
    d: SessionDebrief,
    onOpen: () -> Unit,
) {
    val today = LocalDate.now().toString()
    val whenLabel = if (d.date == today) "today" else "yesterday"
    val sport = d.type?.takeIf { it.isNotBlank() }?.lowercase() ?: "session"
    SectionCard(modifier.clickable(onClick = onOpen), title = "Session debrief") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    d.label?.replaceFirstChar { it.uppercase() } ?: "Analyzed",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
                d.feedback?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    "Your $sport $whenLabel · tap for the full breakdown",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = "Open activity",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// Deterministic last-7-day recap: adherence, load vs target with a trend arrow
// vs last week, the sport split, and the standout session. The coach-voice take
// lives in the briefing at the top; this is the at-a-glance scoreboard.
@Composable
internal fun WeekReviewCard(modifier: Modifier, wr: WeekReview, note: String? = null) {
    fun sportLabel(s: String) = when (s) {
        "run" -> "Run"; "ride" -> "Ride"; "swim" -> "Swim"; "strength" -> "Strength"; else -> "Other"
    }
    SectionCard(modifier, title = "This week") {
        // The coach's voice on the week, above the deterministic scoreboard.
        note?.takeIf { it.isNotBlank() }?.let { QuoteBlock(it) }
        if (wr.sessions == 0 && wr.adherence.planned == 0) {
            Text(
                "No sessions logged yet this week, it fills in as you train.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@SectionCard
        }
        if (wr.adherence.planned > 0) {
            InsetStat(
                "Adherence",
                "${wr.adherence.done}/${wr.adherence.planned} sessions" +
                    (wr.adherence.pct?.let { " · $it%" } ?: ""),
            )
        }
        // Load vs target, with the week-over-week trend arrow (Quick win 5).
        val trend = wr.load.delta_pct?.let { d ->
            val arrow = if (d > 0) "↑" else if (d < 0) "↓" else "→"
            "  $arrow${kotlin.math.abs(d)}% vs last wk"
        } ?: ""
        InsetStat("Load", "${wr.load.tss} / ${wr.load.target} TSS$trend")
        // Sport split — where the load went this week.
        if (wr.by_sport.isNotEmpty()) {
            ChipRow(wr.by_sport.filter { it.tss > 0 }.map { "${sportLabel(it.sport)} ${it.tss}" })
        }
        wr.standout?.let { st ->
            Text(
                "Biggest session: ${sportLabel(st.sport)} on ${st.date} · ${st.tss} TSS",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
internal fun GoalCard(modifier: Modifier, g: GoalProgress) {
    SectionCard(modifier, title = "Goal · ${g.goal}") {
        // Prefer an exact day countdown when we have the race date.
        val days = g.goal_date?.let {
            runCatching { ChronoUnit.DAYS.between(LocalDate.now(), LocalDate.parse(it)) }.getOrNull()
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
                Text(
                    when {
                        days != null && days > 0 -> "$days days to go"
                        days != null && days == 0L -> "Race day! 🏁"
                        g.weeks_to_goal != null -> "${g.weeks_to_goal} weeks to go"
                        else -> "No date set"
                    },
                    style = MaterialTheme.typography.titleMedium,
                )
                g.goal_date?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(g.phase, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text("CTL ${if (g.ctl_trend >= 0) "+" else ""}${"%.1f".format(g.ctl_trend)}/28d",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // Periodization phase timeline — highlights the block you're in now.
        if (g.weeks_to_goal != null) PhaseStrip(g.phase)
        Text(g.on_track, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun PhaseStrip(current: String) {
    val phases = listOf("Base", "Build", "Peak", "Taper")
    val curIdx = phases.indexOfFirst { it.equals(current, ignoreCase = true) }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        phases.forEachIndexed { i, p ->
            val active = i == curIdx
            val done = curIdx >= 0 && i < curIdx
            val c = when {
                active -> MaterialTheme.colorScheme.primary
                done -> MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)
                else -> MaterialTheme.colorScheme.surfaceVariant
            }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.fillMaxWidth().size(width = 0.dp, height = 6.dp)
                    .background(c, RoundedCornerShape(3.dp)))
                Text(p, style = MaterialTheme.typography.labelSmall,
                    color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
