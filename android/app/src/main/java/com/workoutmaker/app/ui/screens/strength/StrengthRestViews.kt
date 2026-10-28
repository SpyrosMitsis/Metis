package com.workoutmaker.app.ui.screens.strength

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.workoutmaker.app.strength.StrengthViewModel
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.theme.amberAccent
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.ui.text.font.FontFamily

@Composable
internal fun RestPicker(restSec: Int, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = if (restSec <= 0) "Rest off" else "Rest ${fmtClock(restSec.toLong())}"
    Box {
        AssistChip(onClick = { open = true }, label = { Text(label) })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(0, 60, 90, 120, 150, 180, 210, 240).forEach { sec ->
                DropdownMenuItem(
                    text = { Text(if (sec == 0) "Off" else fmtClock(sec.toLong())) },
                    onClick = { onPick(sec); open = false },
                )
            }
        }
    }
}

@Composable
internal fun RestTimerBar(remaining: Int, vm: StrengthViewModel) {
    val total by vm.restTotal.collectAsStateSafe()
    RestTimerContent(remaining, total, onAdjust = vm::adjustRest, onSkip = vm::skipRest)
}

@Composable
internal fun RestTimerContent(remaining: Int, total: Int, onAdjust: (Int) -> Unit, onSkip: () -> Unit) {
    val target = (if (total > 0) remaining.toFloat() / total else 0f).coerceIn(0f, 1f)
    val progress by animateFloatAsState(targetValue = target, label = "rest-progress")
    val nearDone = remaining in 1..5
    val accent = if (nearDone) amberAccent() else MaterialTheme.colorScheme.primary
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
        LinearProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxWidth().height(5.dp),
            color = accent,
            trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        )
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "REST",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    letterSpacing = 1.5.sp,
                )
                Text(
                    fmtClock(remaining.toLong()),
                    style = MaterialTheme.typography.headlineSmall.copy(
                        fontFamily = FontFamily.Monospace,
                    ),
                    fontWeight = FontWeight.Bold,
                    color = accent,
                )
            }
            TextButton(onClick = { onAdjust(-15) }) { Text("−15s") }
            TextButton(onClick = { onAdjust(15) }) { Text("+15s") }
            FilledTonalButton(onClick = onSkip) { Text("Skip") }
        }
    }
}
