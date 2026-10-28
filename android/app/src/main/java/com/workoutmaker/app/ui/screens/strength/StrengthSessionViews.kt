package com.workoutmaker.app.ui.screens.strength

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.FitnessCenter
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material.icons.filled.Timer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.workoutmaker.app.strength.StrengthViewModel
import com.workoutmaker.app.ui.collectAsStateSafe
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.zIndex
import com.workoutmaker.app.ui.components.EmptyState
import com.workoutmaker.app.ui.components.rememberDragDropState
import com.workoutmaker.app.ui.components.SectionCard
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.key
import androidx.compose.ui.platform.LocalView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.workoutmaker.app.ui.screens.home.rpeWord



// ---------------------------------------------------------------------------
// Active workout
// ---------------------------------------------------------------------------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ActiveWorkoutView(vm: StrengthViewModel, onOpenStats: (String) -> Unit = {}) {
    val elapsed by vm.elapsedSec.collectAsStateSafe()
    val rest by vm.restRemaining.collectAsStateSafe()
    val status by vm.status.collectAsStateSafe()
    val settings by vm.settings.collectAsStateSafe()
    var menu by remember { mutableStateOf(false) }
    var showPlate by remember { mutableStateOf(false) }
    var confirmFinish by remember { mutableStateOf(false) }
    val finishHaptics = LocalHapticFeedback.current
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0

    // Keep the screen awake during a workout when the user opts in.
    val view = LocalView.current
    DisposableEffect(settings.keepScreenOn) {
        view.keepScreenOn = settings.keepScreenOn
        onDispose { view.keepScreenOn = false }
    }

    // Persist the session whenever the app is backgrounded (captures in-progress
    // text edits to weights/reps/name) so a lock or kill never loses it.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            // Synchronous write — the process may be killed right after backgrounding.
            if (event == Lifecycle.Event.ON_STOP) vm.persistSessionNow()
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    Scaffold(
        modifier = Modifier.imePadding(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(fmtClock(elapsed), fontWeight = FontWeight.Bold)
                        Text("${vm.exercises.size} exercises", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                actions = {
                    Button(onClick = { confirmFinish = true }) { Text(if (vm.isEditing) "Save" else "Finish") }
                    IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Plate calculator") }, onClick = { menu = false; showPlate = true })
                        DropdownMenuItem(text = { Text("Save as routine") }, onClick = { menu = false; vm.saveAsRoutine() })
                        DropdownMenuItem(text = { Text("Cancel workout") }, onClick = { menu = false; vm.cancelWorkout() })
                    }
                },
            )
        },
        bottomBar = {
            ActiveWorkoutBottomBar(
                keyboardVisible = keyboardVisible, rest = rest, status = status,
                timer = { remaining -> RestTimerBar(remaining, vm) },
                onAddExercise = { vm.openPicker() }, onStartRest = { vm.startManualRest() },
            )
        },
    ) { padding ->
        // Drag-to-reorder: exercise cards sit after the two header fields, so
        // LazyColumn indices are exercise index + 2. Only exercise rows are
        // draggable / valid drop targets.
        val listState = rememberLazyListState()
        val headerItems = 2
        val dragState = rememberDragDropState(
            listState,
            canDrag = { info -> info.index - headerItems in vm.exercises.indices },
            onMove = { from, to -> vm.moveExerciseTo(from - headerItems, to - headerItems) },
        )
        LazyColumn(
            Modifier.padding(padding).fillMaxWidth(),
            state = listState,
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                OutlinedTextField(vm.workoutName, { vm.workoutName = it; vm.persistSession() }, label = { Text("Workout name") },
                    modifier = Modifier.fillMaxWidth(), singleLine = true)
            }
            item {
                OutlinedTextField(vm.workoutNote, { vm.workoutNote = it; vm.persistSession() }, label = { Text("Session note (optional)") },
                    modifier = Modifier.fillMaxWidth(), singleLine = false,
                    textStyle = MaterialTheme.typography.bodySmall)
            }
            itemsIndexed(vm.exercises, key = { _, ux -> ux.name + System.identityHashCode(ux) }) { i, ux ->
                val isDragging = dragState.draggingItemIndex == i + headerItems
                val isSettling = dragState.settlingItemIndex == i + headerItems
                Box(
                    when {
                        // The grabbed card floats over its neighbours and tracks the finger.
                        isDragging -> Modifier.zIndex(1f).graphicsLayer {
                            translationY = dragState.draggingItemOffset
                            shadowElevation = 24f
                        }
                        // Just released: glide home from the finger position.
                        isSettling -> Modifier.zIndex(1f).graphicsLayer {
                            translationY = dragState.settlingItemOffset.value
                            shadowElevation = 24f * (dragState.settlingItemOffset.value.let { v ->
                                (kotlin.math.abs(v) / 100f).coerceAtMost(1f)
                            })
                        }
                        else -> Modifier.animateItem()
                    },
                ) {
                    ExerciseCard(vm, ux, dragState, onOpenStats)
                }
            }
            if (vm.exercises.isEmpty()) {
                item {
                    EmptyState(
                        title = "No exercises yet",
                        subtitle = "Tap “Add exercise” to start logging sets.",
                        icon = Icons.Filled.FitnessCenter,
                    )
                }
            }
        }
    }

    if (showPlate) PlateCalcDialog(settings, onClose = { showPlate = false })
    if (confirmFinish) {
        AlertDialog(
            onDismissRequest = { confirmFinish = false },
            title = { Text(if (vm.isEditing) "Save changes?" else "Finish workout?") },
            text = { Text(if (vm.isEditing) "Your edits replace the saved workout." else "Completed sets are saved and synced for your AI coach.") },
            confirmButton = { TextButton(onClick = { confirmFinish = false; finishHaptics.performHapticFeedback(HapticFeedbackType.LongPress); vm.finish() }) { Text(if (vm.isEditing) "Save" else "Finish") } },
            dismissButton = { TextButton(onClick = { confirmFinish = false }) { Text("Keep going") } },
        )
    }
}

/** Keep the live countdown visible above the IME; secondary actions can wait until typing ends. */
@Composable
internal fun ActiveWorkoutBottomBar(
    keyboardVisible: Boolean, rest: Int?, status: String?,
    timer: @Composable (Int) -> Unit, onAddExercise: () -> Unit, onStartRest: () -> Unit,
) {
    Column {
        rest?.let { timer(it) }
        if (!keyboardVisible) {
            status?.let {
                Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onAddExercise, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.Add, null); Text(" Add exercise")
                }
                OutlinedButton(onClick = onStartRest, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.Timer, null); Text(" Rest")
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Post-workout effort rating — session RPE + difficulty feed the AI engine.
// RPE measures effort only — it is NOT a quality score — so the bars use one
// neutral accent rather than a green→red "good/bad" ramp.
// ---------------------------------------------------------------------------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RateEffortView(vm: StrengthViewModel) {
    var rpe by rememberSaveable { mutableStateOf<Int?>(null) }
    var difficulty by rememberSaveable { mutableStateOf<String?>(null) }
    val accent = MaterialTheme.colorScheme.primary
    val haptics = LocalHapticFeedback.current

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = { TopAppBar(title = { Text("Rate your effort") }) },
    ) { padding ->
        // Full page, NO scroll: the bars flex to absorb slack so the readout
        // stays at the top and the buttons stay pinned at the bottom on any phone.
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "How hard did that feel?",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(14.dp))

            // Big animated readout of the chosen effort.
            Text(
                "RATE OF PERCEIVED EXERTION",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                letterSpacing = 1.5.sp,
            )
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    rpe?.toString() ?: "-",
                    style = MaterialTheme.typography.displayLarge,
                    fontWeight = FontWeight.Bold,
                    color = accent,
                )
                Text(
                    " / 10",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 12.dp),
                )
            }
            Text(
                rpe?.let { rpeWord(it).replaceFirstChar { c -> c.uppercase() } } ?: "Tap a bar below",
                style = MaterialTheme.typography.titleMedium,
                color = accent,
            )

            // Flexes to fill whatever space is left between readout and the card.
            EffortBars(
                selected = rpe,
                onSelect = { rpe = it },
                modifier = Modifier.weight(1f).fillMaxWidth().padding(vertical = 16.dp),
            )

            // Quick qualitative tag — strongest signal for autoregulation.
            SectionCard {
                Text(
                    "How did the session go?",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("too_easy" to "Too easy", "just_right" to "Just right", "too_hard" to "Too hard").forEach { (k, label) ->
                        val sel = difficulty == k
                        FilterChip(
                            selected = sel,
                            onClick = { difficulty = if (sel) null else k },
                            label = {
                                Text(
                                    label,
                                    style = MaterialTheme.typography.labelMedium,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    vm.submitEffort(rpe, difficulty)
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(16.dp),
            ) { Text("Save effort", style = MaterialTheme.typography.titleSmall) }
            TextButton(onClick = { vm.skipEffort() }, modifier = Modifier.fillMaxWidth()) {
                Text("Skip", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// Tall, rounded "equalizer" bars in one neutral accent (effort, not a score).
// Bars 1..selected light up; the chosen bar is outlined. Bars and their number
// labels live in separate rows so the numbers always sit on one baseline,
// regardless of how tall each bar is.
@Composable
private fun EffortBars(selected: Int?, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    val idle = MaterialTheme.colorScheme.surfaceContainerHighest
    val haptics = LocalHapticFeedback.current
    Column(modifier) {
        Row(
            Modifier.fillMaxWidth().weight(1f).heightIn(min = 120.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            (1..10).forEach { n ->
                val active = selected != null && n <= selected
                val current = selected == n
                val heightFrac = 0.34f + (n - 1) * (0.66f / 9f)
                val barColor by animateColorAsState(if (active) accent else idle, label = "effortBar$n")
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight(heightFrac)
                        .clip(RoundedCornerShape(50))
                        .background(barColor)
                        .then(
                            if (current) Modifier.border(2.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f), RoundedCornerShape(50))
                            else Modifier,
                        )
                        .clickable {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onSelect(n)
                        },
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            (1..10).forEach { n ->
                val current = selected == n
                Text(
                    "$n",
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (current) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = if (current) FontWeight.Bold else FontWeight.Normal,
                )
            }
        }
    }
}
