package com.workoutmaker.app.ui.screens.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.format
import com.workoutmaker.app.ui.components.SectionCard

@Composable
internal fun ToggleRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/**
 * A number field that lets you finish typing.
 *
 * Binding an `OutlinedTextField` straight to a parsed-and-range-checked model
 * value looks tidy and is unusable: every keystroke is re-parsed, so any prefix
 * of a legal number that is itself illegal is swallowed. Body fat rejected
 * "1", which made every value from 10 to 29 impossible to enter, and the
 * decimal point disappeared the moment you typed it because "12." parses to
 * 12.0 and renders back as "12".
 *
 * So the text is local while the field is being edited, and the parsed value is
 * pushed up on every edit that parses in range (out of range is held, not
 * discarded, until the athlete adds another digit or leaves). External writes
 * still win: when the model changes to something the text does not already
 * describe, the text follows it, which is how the Intervals.icu and Health
 * Connect syncs keep showing up here.
 */
@Composable
internal fun NumberField(
    value: String,
    onValue: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    decimal: Boolean = false,
) {
    var text by remember { mutableStateOf(value) }
    var editing by remember { mutableStateOf(false) }
    if (!editing && text != value) text = value

    OutlinedTextField(
        value = text,
        onValueChange = { raw ->
            // One leading sign-free number: digits, and at most one separator.
            val cleaned = raw.filter { it.isDigit() || (decimal && (it == '.' || it == ',')) }
                .replace(',', '.')
                .let { s ->
                    val dot = s.indexOf('.')
                    if (dot < 0) s else s.substring(0, dot + 1) + s.substring(dot + 1).replace(".", "")
                }
            text = cleaned
            onValue(cleaned)
        },
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number,
        ),
        modifier = modifier.onFocusChanged { f ->
            editing = f.isFocused
            // On the way out, show what was actually stored. A half-typed or
            // out-of-range entry then visibly snaps back instead of looking saved.
            if (!f.isFocused) text = value
        },
    )
}

internal fun restLabel(sec: Int): String =
    if (sec <= 0) "Off" else if (sec < 60) "${sec}s" else "%d:%02d".format(sec / 60, sec % 60)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChipGroup(label: String, options: List<String>, selected: String?, onSelect: (String) -> Unit) {
    Text(label, style = MaterialTheme.typography.labelLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        options.forEach { opt ->
            FilterChip(selected = selected == opt, onClick = { onSelect(opt) }, label = { Text(opt) })
        }
    }
}

/**
 * A toggle with an icon in front of it. The icon is what lets a column of
 * settings be scanned rather than read, which is the whole reason the design
 * puts one on every row that does something to your phone.
 */
@Composable
internal fun IconToggleRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (checked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(end = 14.dp).size(22.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** One option in a [ChoiceTiles] row: what it says, and what it is worth. */
internal data class TileChoice(val label: String, val value: String, val selected: Boolean, val onClick: () -> Unit)

/**
 * Two or three equal tiles, one of them chosen. Used where a choice has a NUMBER
 * attached (weekly load, bar weight): a chip can carry the label or the number
 * but not both, and the number is usually the part being compared.
 */
@Composable
internal fun ChoiceTiles(items: List<TileChoice>, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items.forEach { item ->
            Column(
                Modifier.weight(1f).fillMaxHeight()
                    .clip(RoundedCornerShape(16.dp))
                    .background(
                        if (item.selected) MaterialTheme.colorScheme.primaryContainer
                        else MaterialTheme.colorScheme.surfaceContainerLowest,
                    )
                    .clickable(onClick = item.onClick)
                    .padding(vertical = 14.dp, horizontal = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    item.label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (item.selected) MaterialTheme.colorScheme.onPrimaryContainer
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Text(
                    item.value,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = if (item.selected) MaterialTheme.colorScheme.onPrimaryContainer
                    else MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * One line of a breakdown: what it was, and what it came to. Right-aligned value
 * so a column of them can be read down without tracking across the label.
 */
@Composable
internal fun BreakdownRow(label: String, value: String, emphasis: Boolean = false) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (emphasis) FontWeight.Bold else FontWeight.SemiBold,
            color = if (emphasis) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        )
    }
}

/**
 * A connection or a data route, as a card: what it is, whether it is on, what
 * you LOSE without it, and the one button that changes that. The "without it"
 * line is the point, and it is what a bare toggle can never say.
 */
@Composable
internal fun LinkCard(
    icon: ImageVector,
    title: String,
    status: String,
    connected: Boolean,
    body: String,
    content: @Composable () -> Unit,
) {
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(end = 12.dp).size(22.dp),
            )
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    status,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (connected) {
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = "Connected",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}

