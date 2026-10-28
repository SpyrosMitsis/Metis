package com.workoutmaker.app.ui.screens.strength

import androidx.compose.foundation.background
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.automirrored.filled.NoteAdd
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.strength.StrengthViewModel
import com.workoutmaker.app.strength.UiExercise
import com.workoutmaker.app.strength.UiSet
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.ui.input.pointer.pointerInput
import com.workoutmaker.app.ui.components.DragDropState
import com.workoutmaker.app.ui.components.SectionCard
import androidx.compose.runtime.key
import com.workoutmaker.app.strength.SetEntity
import com.workoutmaker.app.strength.SetSanity

@Composable
internal fun ExerciseCard(
    vm: StrengthViewModel,
    ux: UiExercise,
    dragState: DragDropState? = null,
    onOpenStats: (String) -> Unit = {},
) {
    var menu by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // Q4: grab the handle and drag the card to reorder the session.
            if (dragState != null) {
                Icon(
                    Icons.Filled.DragHandle, "Reorder",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .size(40.dp)
                        // Gesture area = the full 40dp square (padding only shrinks the glyph).
                        .pointerInput(dragState, ux) {
                            detectDragGestures(
                                onDragStart = {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    // Must match the LazyColumn item key exactly.
                                    dragState.onDragStart(ux.name + System.identityHashCode(ux))
                                },
                                onDrag = { change, amount -> change.consume(); dragState.onDrag(amount.y) },
                                onDragEnd = { dragState.onDragEnd() },
                                onDragCancel = { dragState.onDragEnd() },
                            )
                        }
                        .padding(8.dp),
                )
            }
            // Tap the name to open this exercise's history page.
            Column(Modifier.weight(1f).clickable { onOpenStats(ux.name) }) {
                Text(ux.name, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                Text(ux.muscle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = {
                val units = listOf("reps", "seconds", "metres", "minutes")
                if (ux.sets.none { it.done }) { ux.quantityUnit = units[(units.indexOf(ux.quantityUnit) + 1) % units.size]; vm.persistSession() }
            }) { Text(ux.quantityUnit) }
            RestPicker(ux.restSec) { vm.setRest(ux, it) }
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.MoreVert, "Exercise options", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (!ux.isCardio) {
                        DropdownMenuItem(
                            text = { Text("Add warm-up sets") },
                            onClick = { menu = false; vm.addWarmupRamp(ux) },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text("Replace exercise") },
                        onClick = { menu = false; vm.openPickerForReplace(ux) },
                    )
                    DropdownMenuItem(
                        text = { Text("Remove exercise", color = MaterialTheme.colorScheme.error) },
                        onClick = { menu = false; vm.removeExercise(ux) },
                    )
                }
            }
        }
        // B1 auto-progression target
        ux.suggestion?.let { s ->
            Text("↗ Target ${trimKg(s.weightKg)}kg × ${s.reps} · ${s.note}",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
        }
        // Column headers share the SetRow grid exactly so labels sit over their
        // fields. Inputs are flexible (weight); cardio's single MIN fills the area.
        Row(
            Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HCell("SET", Modifier.width(30.dp)); HCell("PREV", Modifier.width(56.dp))
            if (ux.isCardio || ux.isBand) {
                HCell(if (ux.isCardio) "MIN" else ux.quantityUnit.uppercase(), Modifier.weight(1f))
            } else {
                HCell(if (ux.isBand) "BAND: NOTE" else if (ux.name.contains("assisted", true)) "ASSIST KG" else "KG", Modifier.weight(1f)); HCell(ux.quantityUnit.uppercase(), Modifier.weight(1f))
            }
            // Reserve the note + check columns (no labels) so the weighted headers
            // line up with the fields above the icons.
            Spacer(Modifier.width(36.dp)); Spacer(Modifier.width(40.dp))
        }
        // Working-set numbering: warm-ups show "W" and don't consume a number.
        var working = 0
        ux.sets.forEachIndexed { i, s ->
            val label = if (s.warmup) "W" else { working += 1; working.toString() }
            // Key by the set's identity so swipe-dismiss state follows the row it
            // belongs to (otherwise deleting one freezes the dismissed background
            // onto the row that shifts into its slot).
            key(System.identityHashCode(s)) {
                SetRow(
                    label, s, ux.previous.getOrNull(i)?.takeIf { it.quantityUnit == ux.quantityUnit },
                    cardio = ux.isCardio, noWeight = ux.isBand, quantityUnit = ux.quantityUnit,
                    onToggle = { vm.toggleDone(ux, s) },
                    onRemove = { vm.removeSet(ux, s) },
                    onEdit = { vm.persistSession() },
                )
            }
        }
        TextButton(onClick = { vm.addSet(ux) }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Filled.Add, null); Text(" Add set")
        }
    }
}

@Composable
internal fun HCell(text: String, modifier: Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SetRow(
    label: String,
    s: UiSet,
    prev: SetEntity?,
    cardio: Boolean = false,
    quantityUnit: String = "reps",
    noWeight: Boolean = false,
    onToggle: () -> Unit,
    onRemove: () -> Unit,
    onEdit: () -> Unit = {},
) {
    var showNote by remember { mutableStateOf(s.note.isNotBlank()) }
    // Set when the done-toggle catches an entry far outside the usual values;
    // holds the toggle until the athlete confirms it was not a typo.
    var oddEntryQuestion by remember { mutableStateOf<String?>(null) }
    val haptics = LocalHapticFeedback.current
    // Opaque so the red delete background only shows while swiping.
    val rowBg = if (s.done) {
        MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
            .compositeOver(MaterialTheme.colorScheme.surface)
    } else {
        MaterialTheme.colorScheme.surface
    }
    // Swipe the row left to delete the set (red trash revealed on the right).
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { target ->
            if (target == SwipeToDismissBoxValue.EndToStart) {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                onRemove()
                true
            } else {
                false
            }
        },
        positionalThreshold = { it * 0.45f },
    )
    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        backgroundContent = {
            // Rendered only mid-swipe: at rest the red layer peeked out of the
            // row's rounded corners as a hairline sliver.
            if (dismissState.dismissDirection == SwipeToDismissBoxValue.EndToStart) {
                Box(
                    Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.error.copy(alpha = 0.9f)).padding(horizontal = 20.dp),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    Icon(Icons.Filled.Delete, "Delete set", tint = MaterialTheme.colorScheme.onError)
                }
            }
        },
    ) {
    Column(Modifier.fillMaxWidth().background(rowBg, RoundedCornerShape(8.dp)).padding(vertical = 6.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // working-set number / warmup toggle
            Box(Modifier.width(30.dp), contentAlignment = Alignment.Center) {
                Text(
                    label,
                    Modifier.clickable { s.warmup = !s.warmup },
                    color = if (s.warmup) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.Bold,
                )
            }
            // Tap a previous result to copy it straight into this set's fields.
            Text(
                prev?.let { if (cardio) "${it.reps} min" else "${it.weightKg.toInt()}×${it.reps} ${it.quantityUnit}" } ?: "-",
                Modifier.width(56.dp)
                    .then(
                        if (prev != null) Modifier.clickable {
                            if (!cardio && !noWeight) s.weight = trimKg(prev.weightKg)
                            s.reps = prev.reps.toString()
                            onEdit()
                        } else Modifier,
                    ),
                style = MaterialTheme.typography.bodySmall,
                color = if (prev != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            if (cardio || noWeight) {
                // Minutes live in the reps slot; no load to enter. Fills the row.
                CompactField(s.reps, { s.reps = it; onEdit() }, Modifier.weight(1f), decimal = false, placeholder = s.suggestedReps)
            } else {
                CompactField(s.weight, { s.weight = it; s.confirmedOdd = false; onEdit() }, Modifier.weight(1f), decimal = true, placeholder = s.suggestedWeight)
                CompactField(s.reps, { s.reps = it; s.confirmedOdd = false; onEdit() }, Modifier.weight(1f), decimal = false, placeholder = s.suggestedReps)
            }
            IconButton(onClick = { showNote = !showNote }, modifier = Modifier.size(36.dp)) {
                Icon(Icons.AutoMirrored.Filled.NoteAdd, "Note",
                    tint = if (s.note.isNotBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp))
            }
            IconButton(
                onClick = {
                    val becomingDone = !s.done
                    // Typo guard on the moment of commit: a wild weight/reps must
                    // be confirmed before it can count (it would otherwise become
                    // a fake PR and skew every later suggestion). Cardio logs
                    // minutes in the reps slot, so it only gets the weight-free
                    // absolute rep cap via baselines being null.
                    val question = if (becomingDone && !s.confirmedOdd && !cardio && !noWeight && quantityUnit == "reps") {
                        SetSanity.check(
                            weight = s.weight.toDoubleOrNull(),
                            reps = s.reps.toIntOrNull(),
                            baselineWeight = prev?.weightKg ?: s.suggestedWeight.toDoubleOrNull(),
                            baselineReps = prev?.reps ?: s.suggestedReps.toIntOrNull(),
                            warmup = s.warmup,
                        )
                    } else null
                    if (question != null) {
                        oddEntryQuestion = question
                    } else {
                        onToggle()
                        if (becomingDone) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    }
                },
                modifier = Modifier.size(40.dp),
            ) {
                Icon(Icons.Filled.Check, "Done", tint = if (s.done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (showNote) {
            Spacer(Modifier.height(8.dp))
            NoteField(s.note, { s.note = it; onEdit() })
        }
    }
    }
    // Neutral confirmation, not an error: the entry may well be real. Confirming
    // marks the set so it is not re-asked; editing either field re-arms it.
    oddEntryQuestion?.let { question ->
        AlertDialog(
            onDismissRequest = { oddEntryQuestion = null },
            title = { Text("Double-check this set") },
            text = { Text(question) },
            confirmButton = {
                TextButton(onClick = {
                    s.confirmedOdd = true
                    oddEntryQuestion = null
                    onToggle()
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                }) { Text("Log it") }
            },
            dismissButton = {
                TextButton(onClick = { oddEntryQuestion = null }) { Text("Fix it") }
            },
        )
    }
}

// Borderless, filled note field matching the cell style; full-width with a touch
// of inset so it sits clearly below the set's row rather than cramping it.
@Composable
private fun NoteField(value: String, onChange: (String) -> Unit) {
    Box(
        Modifier.fillMaxWidth().padding(start = 30.dp, end = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        BasicTextField(
            value = value, onValueChange = onChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            textStyle = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            decorationBox = { inner ->
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text("Note (e.g. felt easy, left knee)",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f))
                    }
                    inner()
                }
            },
        )
    }
}

// Borderless, filled input cell: a recessed (darker than the card) rounded box
// with centered text. No outline. The greyed placeholder is the AI/last-time
// suggestion and disappears the moment the user types.
@Composable
internal fun CompactField(
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier,
    decimal: Boolean,
    placeholder: String = "",
) {
    val centered = MaterialTheme.typography.bodyMedium.copy(textAlign = TextAlign.Center)
    Box(
        modifier
            .height(44.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        BasicTextField(
            value = value,
            onValueChange = onChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            textStyle = centered.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            keyboardOptions = KeyboardOptions(keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number),
            decorationBox = { inner ->
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (value.isEmpty() && placeholder.isNotBlank()) {
                        Text(
                            placeholder,
                            style = centered,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    inner()
                }
            },
        )
    }
}
