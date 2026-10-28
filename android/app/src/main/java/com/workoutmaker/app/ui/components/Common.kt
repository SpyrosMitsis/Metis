package com.workoutmaker.app.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import com.workoutmaker.app.ui.theme.mossAccent

// A consistent top-bar + scrolling body used by every screen.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(
    title: String,
    subtitle: String? = null,
    // Small uppercase kicker above the title. Each screen passes one that names
    // its job (e.g. "DAILY READINESS") so the top bar is contextual, not a fixed
    // brand stamp.
    eyebrow: String = "BIO-METRICS",
    // When set, the title becomes a tappable control (gets a small caret) — used
    // by Home to turn the date headline into a date picker.
    onTitleClick: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {},
    navigationIcon: @Composable () -> Unit = {},
    scrollable: Boolean = true,
    isRefreshing: Boolean = false,
    onRefresh: (() -> Unit)? = null,
    content: @Composable (Modifier) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                // Roomier than the default 64.dp so the eyebrow/title/subtitle
                // block isn't squashed.
                expandedHeight = 84.dp,
                navigationIcon = navigationIcon,
                title = {
                    Column(
                        Modifier.padding(vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(
                            eyebrow,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                            letterSpacing = 2.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        // One line each: the app bar has a fixed height, so a long
                        // title (e.g. a workout name) wrapping would get clipped by
                        // the content below instead of ellipsized.
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = if (onTitleClick != null) {
                                Modifier.clip(RoundedCornerShape(8.dp)).clickable { onTitleClick() }
                                    .padding(end = 6.dp)
                            } else Modifier,
                        ) {
                            Text(
                                title,
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (onTitleClick != null) {
                                Icon(
                                    Icons.Filled.KeyboardArrowDown,
                                    contentDescription = "Change date",
                                    modifier = Modifier.size(22.dp).padding(start = 2.dp),
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                        if (subtitle != null) {
                            Text(
                                subtitle,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = { actions() },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        val body: @Composable () -> Unit = {
            val base = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp)
            if (scrollable) {
                Column(
                    base.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    content(Modifier.fillMaxWidth())
                    Box(Modifier.padding(bottom = 8.dp))
                }
            } else {
                content(base)
            }
        }
        if (onRefresh != null) {
            PullToRefreshBox(
                isRefreshing = isRefreshing,
                onRefresh = onRefresh,
                modifier = Modifier.fillMaxSize().padding(padding),
            ) { body() }
        } else {
            Box(Modifier.fillMaxSize().padding(padding)) { body() }
        }
    }
}

// Soft, elevated card used everywhere for visual consistency.
@Composable
fun SectionCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (title != null) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            }
            content()
        }
    }
}

/**
 * A calm, centered empty state: optional icon, a title, and a supporting line.
 * Use instead of a lone muted Text so "nothing here yet" reads as intentional.
 */
@Composable
fun EmptyState(
    title: String,
    subtitle: String? = null,
    icon: ImageVector? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) {
            Icon(
                icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.7f),
                modifier = Modifier.size(36.dp),
            )
        }
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
        if (subtitle != null) {
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * A shimmering placeholder bar for loading skeletons. Width is a fraction of the
 * available width so a column of these reads as "content is coming".
 */
@Composable
fun SkeletonBar(
    modifier: Modifier = Modifier,
    widthFraction: Float = 1f,
    height: Dp = 16.dp,
) {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.25f,
        targetValue = 0.6f,
        animationSpec = infiniteRepeatable(
            animation = tween(800),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "skeleton-alpha",
    )
    Box(
        modifier
            .fillMaxWidth(widthFraction)
            .height(height)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = alpha * 0.25f)),
    )
}

/** A few skeleton lines standing in for a card while data loads. */
@Composable
fun SkeletonCard(lines: Int = 3, modifier: Modifier = Modifier) {
    SectionCard(modifier) {
        SkeletonBar(widthFraction = 0.5f, height = 20.dp)
        repeat(lines) { i ->
            SkeletonBar(widthFraction = if (i == lines - 1) 0.7f else 1f)
        }
    }
}

// ============================================================================
// Serene Vanguard component kit — small, reusable pieces that give every screen
// the same calm, tonal language (label-caps, chips, inset stats, ghost buttons).
// ============================================================================

/** Uppercase, letter-spaced section/eyebrow label in muted sage. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.primary) {
    Text(
        text.uppercase(),
        modifier = modifier,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        letterSpacing = 1.5.sp,
        fontWeight = FontWeight.Bold,
    )
}

/**
 * Two-option pill toggle (e.g. Steady/Periodized, Spread automatically/I'll pick) —
 * one shared container instead of two independent FilterChips, so the choice reads
 * as ONE decision rather than two buttons that happen to be mutually exclusive.
 */
@Composable
fun SegmentedToggle(leftLabel: String, rightLabel: String, right: Boolean, onChange: (Boolean) -> Unit) {
    SegmentedChoice(
        labels = listOf(leftLabel, rightLabel),
        selectedIndex = if (right) 1 else 0,
        onSelect = { onChange(it == 1) },
    )
}

/**
 * The same pill track for N options (Dark / Light / System). [SegmentedToggle] is
 * the two-option case; anything wider (the appearance picker) uses this directly.
 */
@Composable
fun SegmentedChoice(labels: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    // The TRACK is recessed (deeper than the card behind it, same language as
    // InsetStat/StatTile) and the selected segment sits raised on top of it. With a
    // transparent track the unselected halves read as page background and the
    // whole thing looked like one button, not a switch. Low, not Lowest:
    // Lowest is ~17 steps under the card in dark mode and read as a black hole.
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(50))
            .padding(4.dp),
    ) {
        labels.forEachIndexed { i, label ->
            val selected = selectedIndex == i
            Box(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(50))
                    .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                    .selectable(selected = selected, role = Role.RadioButton) { onSelect(i) }
                    .padding(vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelLarge,
                    color = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * A labeled group of content, either boxed in a [SectionCard] (Settings) or left
 * frameless with just the label (onboarding's steps are deliberately card-free —
 * see StepColumn) — same content, presentation picked by the caller.
 */
@Composable
fun GroupedSection(grouped: Boolean, label: String, content: @Composable ColumnScope.() -> Unit) {
    if (grouped) {
        SectionCard { SectionLabel(label); Column(verticalArrangement = Arrangement.spacedBy(10.dp), content = content) }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { SectionLabel(label); content() }
    }
}

/** Low-contrast metadata chip: Moss background, Sage text (run · 60min · RPE 4). */
@Composable
fun MetaChip(text: String) {
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(mossAccent().copy(alpha = 0.45f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
    }
}

/** A horizontally-scrolling row of metadata chips. */
@Composable
fun ChipRow(items: List<String>, modifier: Modifier = Modifier) {
    val scroll = rememberScrollState()
    Row(
        modifier.fillMaxWidth().horizontalScroll(scroll),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) { items.forEach { MetaChip(it) } }
}

/** Inset metric row inside a card (darker than the card → "inset" feel). */
@Composable
fun InsetStat(label: String, value: String, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * A single metric tile: small uppercase label above a prominent value, on an
 * inset (recessed) background. Reads as a clean stat block — use several in a
 * [StatTileGrid] instead of stacking full-width [InsetStat] rows.
 */
@Composable
fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            label.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            letterSpacing = 0.6.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * Lays metric tiles out in equal-width columns: a single row when there are ≤3
 * stats, otherwise a 2-column grid. Trailing gaps keep tiles aligned.
 */
@Composable
fun StatTileGrid(items: List<Pair<String, String>>, modifier: Modifier = Modifier) {
    if (items.isEmpty()) return
    val columns = if (items.size <= 3) items.size else 2
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items.chunked(columns).forEach { row ->
            Row(
                // Match every tile in a row to the tallest one, so a stat whose
                // label fits on one line (e.g. "Form (TSB)") isn't shorter than its
                // two-line neighbours ("Fitness (CTL)").
                Modifier.fillMaxWidth().height(IntrinsicSize.Max),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                row.forEach { (l, v) -> StatTile(l, v, Modifier.weight(1f).fillMaxHeight()) }
                repeat(columns - row.size) { Box(Modifier.weight(1f)) }
            }
        }
    }
}

/** Ghost (secondary) button: 1px warm-sand border, transparent fill. */
@Composable
fun GhostButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.secondary.copy(alpha = 0.6f)),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        content = content,
    )
}

/** Coach-note / callout: inset box with a left sage accent bar. */
@Composable
fun QuoteBlock(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .height(IntrinsicSize.Min),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
        Text(
            text,
            Modifier.padding(12.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontStyle = FontStyle.Italic,
        )
    }
}

// ============================================================================
// Metric explanations — a tappable ⓘ that opens a plain-language definition.
// Demystifies the readiness score, TSS, wellness, and the fitness curve.
// ============================================================================

/** Plain-language copy for each metric, kept in one place. */
object Metrics {
    const val READINESS =
        "Your Ready-to-Train score (0-100) estimates how primed your body is for hard work " +
        "*today*. It blends three things pulled each morning:\n\n" +
        "• Wellness: your own check-in (energy, soreness, sleep).\n" +
        "• HRV change: heart-rate variability vs your baseline; a big drop signals stress or " +
        "incomplete recovery.\n" +
        "• Resting-HR change: an elevated resting heart rate points to fatigue or illness.\n\n" +
        "Green (≈67+) = go hard if planned. Amber (≈34-66) = train, but ease off. " +
        "Red (≈<34) = recover; the plan will pull intensity back.\n\n" +
        "It's a guide, not a verdict, how you actually feel still wins."

    const val RECOVERY =
        "Recovery (0-100) is how well your body has bounced back, read from overnight signals:\n\n" +
        "• HRV vs baseline: heart-rate variability; higher than your norm = well recovered, a " +
        "sharp drop = stress or incomplete recovery.\n" +
        "• Resting HR vs baseline: an elevated resting heart rate points to fatigue or illness.\n" +
        "• Sleep: last night's duration vs your personal average and a ~7.5h target.\n" +
        "• Wellness: your subjective check-in (energy, soreness, sleep quality).\n\n" +
        "Green = recovered, push if planned. Amber = moderate, keep quality light. Red = " +
        "under-recovered, and the AI will pull intensity and volume back when it builds your session."

    const val WELLNESS =
        "Wellness is the average of your daily check-in: energy, soreness, and sleep quality, " +
        "each rated 1-5. It feeds the readiness score and nudges the AI to back off when you're " +
        "run-down. Log it honestly, garbage in, garbage out."

    const val TSS =
        "TSS (Training Stress Score) is one number for how much a session taxes you, combining " +
        "duration and intensity. A steady easy hour ≈ 50; a hard hour ≈ 100+. It's how the planner " +
        "balances your week and tracks load, so a short brutal interval session and a long easy run " +
        "can be compared fairly."

    const val FITNESS =
        "These are models of recorded training load, not direct tests of fitness or recovery:\n\n" +
        "• Fitness (CTL): a smoothed longer-term load estimate, commonly using 42 days.\n" +
        "• Fatigue (ATL): a smoothed recent load estimate, commonly using 7 days.\n" +
        "• Form (TSB) = CTL minus ATL. It describes the difference between these models.\n" +
        "• Ramp: how quickly the modeled load is changing.\n\n" +
        "Interpret these alongside actual training, symptoms and how you feel. A ratio alone does not predict injury or establish readiness."

    const val WEEK_CARD =
        "The week card summarises the current training week: how many sessions are planned vs done, " +
        "the week's focus (e.g. Base, Build, Peak, Taper), and your progress toward the weekly load " +
        "target. Use it to see at a glance whether you're on track before the week runs out."
}

@Composable
fun InfoIcon(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }, modifier = modifier.size(28.dp)) {
        Icon(
            Icons.Outlined.Info,
            contentDescription = "What is this?",
            tint = tint,
            modifier = Modifier.size(18.dp),
        )
    }
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = { open = false }) { Text("Got it") }
            },
            title = { Text(title) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(body, style = MaterialTheme.typography.bodyMedium)
                }
            },
        )
    }
}
