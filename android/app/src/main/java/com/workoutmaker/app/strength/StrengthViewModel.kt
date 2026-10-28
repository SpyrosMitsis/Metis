package com.workoutmaker.app.strength

import com.workoutmaker.app.util.runCatching

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.AppPreferences
import com.workoutmaker.app.data.AppSettings
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Intent
import android.os.VibratorManager
import android.util.Log
import com.workoutmaker.app.data.PlannedWorkout
import com.workoutmaker.app.data.RestChime
import com.workoutmaker.app.data.Workout
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.notify.RestAlarmReceiver
import com.workoutmaker.app.notify.playCountdownTick
import com.workoutmaker.app.notify.playRestOverSound
import com.workoutmaker.app.notify.vibrateStrong
import com.workoutmaker.app.work.FeedbackSyncWorker
import com.workoutmaker.app.work.StrengthSync
import com.workoutmaker.app.work.WorkoutForegroundService
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import com.workoutmaker.app.data.cachedPlannedWorkouts
import com.workoutmaker.app.data.undoSkip
import com.workoutmaker.app.data.plannedWorkouts











@HiltViewModel
class StrengthViewModel @Inject constructor(
    private val repo: StrengthRepository,
    private val workoutRepo: WorkoutRepository,
    private val prefs: AppPreferences,
    private val handoff: StrengthHandoff,
    private val catalog: StrengthCatalog,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    // When set, this session was opened from a planned calendar workout; on
    // finish we mark that plan complete (#: "auto-done when I press finish").
    private var linkedPlannedId: String? = null
    private var prescribedTargets = false
    private var linkedPlannedDate: String? = null

    // A planned session waiting on the user's call to discard an in-progress
    // workout (the "keep or replace?" guard). Null when nothing's pending.
    val pendingPlannedStart = MutableStateFlow<StrengthHandoff.Start?>(null)

    // History/Calendar → "edit this logged workout" handoff, with the same
    // in-progress-session guard as planned starts.
    val pendingEditStart = MutableStateFlow<String?>(null)

    /** User chose to discard the in-progress session and load the planned one. */
    fun confirmReplaceWithPlanned() {
        pendingPlannedStart.value?.let { startPlanned(it) }
        pendingPlannedStart.value = null
    }

    /** User chose to keep their current session; drop the planned request. */
    fun keepCurrentSession() { pendingPlannedStart.value = null }

    /** User chose to discard the in-progress session and edit the logged one. */
    fun confirmReplaceWithEdit() {
        pendingEditStart.value?.let { editWorkout(it) }
        pendingEditStart.value = null
    }

    /** User chose to keep their current session; drop the edit request. */
    fun keepCurrentSessionOverEdit() { pendingEditStart.value = null }

    // Today's planned strength sessions from the calendar, shown on the
    // Strength home so the plan is one tap from the logger.
    val todayPlanned = MutableStateFlow<List<PlannedWorkout>>(emptyList())

    val undoingPlanned = MutableStateFlow<String?>(null)

    fun markPlannedUndone(id: String) = viewModelScope.launch {
        if (!undoingPlanned.compareAndSet(null, id)) return@launch
        try {
            runCatching { workoutRepo.undoSkip(id) }
                .onSuccess {
                    todayPlanned.value = todayPlanned.value.map {
                        if (it.id == id) it.copy(completed = false, skipped = false) else it
                    }
                    status.value = "Marked as not done"
                    loadHome()
                }
                .onFailure { status.value = "Couldn't update: ${it.message}" }
        } finally {
            undoingPlanned.value = null
        }
    }

    /** Start logging a planned calendar session from the Strength home card. */
    fun startPlannedFromHome(w: PlannedWorkout) {
        val s = StrengthHandoff.Start(w.workout_json, w.id, w.date)
        if (exercises.isNotEmpty()) pendingPlannedStart.value = s else startPlanned(s)
    }

    // Device-local preferences (units, rest defaults, vibration…) for the UI,
    // plus a synchronous cache for timer/vibration decisions.
    val settings = prefs.settings.stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())
    private var cfg = AppSettings()
    init { viewModelScope.launch { prefs.settings.collect { cfg = it } } }

    val nav = MutableStateFlow<StrengthNav>(StrengthNav.Home)

    var workoutName by mutableStateOf("Workout")
    var workoutNote by mutableStateOf("")
    val exercises = mutableStateListOf<UiExercise>()
    var startedAt = 0L; private set

    // Q2: non-null while editing an already-logged workout (re-saved in place).
    private var editingWorkoutId: String? = null
    private var editingEndedAt = 0L
    val isEditing get() = editingWorkoutId != null

    val elapsedSec = MutableStateFlow(0L)
    private var tickJob: Job? = null

    val restRemaining = MutableStateFlow<Int?>(null)
    val restTotal = MutableStateFlow(0)
    private var restJob: Job? = null
    // Absolute epoch-ms the rest ends — countdown is derived from the clock so it
    // stays accurate across backgrounding and survives process death.
    private var restEndAt = 0L

    val history = MutableStateFlow<List<WorkoutEntity>>(emptyList())
    val workoutDetail = MutableStateFlow<WorkoutDetailUi?>(null)
    val routines = MutableStateFlow<List<RoutineWithItems>>(emptyList())
    val exerciseSummaries = MutableStateFlow<Map<String, ExerciseLogSummary>>(emptyMap())
    val hiddenExerciseStats = MutableStateFlow<Set<String>>(emptySet())
    val statsMessage = MutableStateFlow<String?>(null)
    val loggedExercises = MutableStateFlow<List<String>>(emptyList())
    // Per-exercise stats live in `catalog` (see StrengthCatalog.kt) — this is a
    // read-only pass-through so no Composable call site needs to change.
    val currentStats: StateFlow<ExerciseStats?> get() = catalog.currentStats
    val status = MutableStateFlow<String?>(null)
    val loading = MutableStateFlow(false)

    // Restore any in-progress session left behind by a lock/kill — done here,
    // AFTER every property it touches (status, exercises, rest fields…) is
    // initialised, and synchronously so the workout is ready on first frame.
    private val snapshotFile = SessionSnapshotFile(File(context.filesDir, "active_session.json"))

    init { restoreSavedSession() }

    // Observe the Calendar → Strength handoffs: opening the tab with a pending
    // request seeds the logger from the plan — but guard an in-progress session.
    // MUST come after every property above: viewModelScope is Main.immediate, so
    // when a handoff is already pending the collect body runs synchronously
    // during construction (touching `exercises` earlier NPE'd).
    init {
        viewModelScope.launch {
            handoff.pending.collect { s ->
                if (s != null) {
                    handoff.clear()
                    if (exercises.isNotEmpty()) pendingPlannedStart.value = s // ask before discarding
                    else startPlanned(s)
                }
            }
        }
        viewModelScope.launch {
            handoff.pendingEdit.collect { id ->
                if (id != null) {
                    handoff.clearEdit()
                    if (exercises.isNotEmpty()) pendingEditStart.value = id // ask before discarding
                    else editWorkout(id)
                }
            }
        }
    }

    // New surfaces: weekly volume/deload (B2/B5), PR celebration (C2), programs (B4).
    val weeklyReport = MutableStateFlow<WeeklyReport?>(null)
    val lastPrs = MutableStateFlow<List<PrHit>>(emptyList())
    // Picker favorites/recents/custom (D1/D5) live in `catalog` — read-only
    // pass-throughs so no Composable call site needs to change.
    val favorites: StateFlow<List<String>> get() = catalog.favorites
    val recentExercises: StateFlow<List<String>> get() = catalog.recentExercises
    val customExercises: StateFlow<List<Exercise>> get() = catalog.customExercises
    val programs: List<StrengthProgram> = StrengthPrograms.all

    // Count of local strength changes not yet pushed to the cloud (offline queue).
    val pendingSync = MutableStateFlow(0)

    // Ask WorkManager to drain the offline queue (runs now if online, else when a
    // connection returns — even if the app is closed).
    private fun requestSync() {
        StrengthSync.request(context)
        viewModelScope.launch { runCatching { pendingSync.value = repo.pendingSyncCount() } }
    }

    fun loadHome() = viewModelScope.launch {
        loading.value = true
        runCatching {
            repo.loadAndRegisterCustom()
            // One-time: collapse reworded AI/custom exercises onto their bundled
            // catalog twin so stats/muscle-grouping use the canonical entry.
            if (!prefs.customsCleanupV1Done()) {
                val tidied = runCatching { repo.cleanupMislabeledCustoms() }.getOrDefault(0)
                prefs.setCustomsCleanupV1Done()
                if (tidied > 0) status.value = "Tidied $tidied exercise name(s) to match the catalog"
            }
            runCatching { repo.mergeFromCloud() }
                .onSuccess { merged -> if (merged > 0) status.value = "Synced $merged new workout(s) from the cloud" }
                .onFailure { status.value = "Couldn't refresh cloud history. Showing your saved workouts." }
            history.value = repo.recentWorkouts()
            routines.value = repo.routines()
            refreshStatsIndex()
            weeklyReport.value = repo.weeklyReport()
            pendingSync.value = repo.pendingSyncCount()
        }
        // Surface today's planned strength sessions (offline cache as fallback).
        runCatching {
            val today = LocalDate.now().toString()
            val rows = runCatching { workoutRepo.plannedWorkouts(today) }
                .getOrElse { workoutRepo.cachedPlannedWorkouts() }
            todayPlanned.value = rows
                .filter { it.date == today && it.type == "strength" }
                .sortedBy { it.completed }
        }
        loading.value = false
        requestSync()
    }

    fun loadPicker() = viewModelScope.launch { catalog.loadPicker() }

    fun dismissPrs() { lastPrs.value = emptyList() }

    fun toggleFavorite(name: String) = viewModelScope.launch { catalog.toggleFavorite(name) }

    fun addCustomExercise(name: String, muscle: String, category: String, compound: Boolean) = viewModelScope.launch {
        if (!catalog.addCustomExercise(name, muscle, category, compound)) return@launch
        status.value = "✓ Added “${name.trim()}”"
        requestSync()
    }

    private suspend fun refreshStatsIndex() {
        loggedExercises.value = repo.loggedExercises()
        exerciseSummaries.value = repo.exerciseLogSummaries().associateBy { it.name }
        hiddenExerciseStats.value = repo.hiddenExerciseStats()
    }

    fun loadStatsIndex() = viewModelScope.launch {
        statsMessage.value = null
        runCatching { catalog.loadPicker(); refreshStatsIndex() }
            .onFailure { statsMessage.value = "Could not refresh exercise stats." }
    }

    fun restoreExerciseStats(name: String) = viewModelScope.launch {
        runCatching { repo.restoreExerciseStats(name); refreshStatsIndex() }
            .onSuccess { statsMessage.value = "Exercise stats restored." }
            .onFailure { statsMessage.value = "Could not restore the exercise to stats." }
    }

    fun deleteCustomExercise(name: String) = viewModelScope.launch {
        if (ExerciseCatalog.all.any { it.name == name } && !ExerciseCatalog.isCustom(name)) return@launch
        runCatching { catalog.deleteCustomExercise(name); requestSync(); refreshStatsIndex() }
            .onSuccess {
                statsMessage.value = "Custom entry removed. Workout history kept."
                status.value = statsMessage.value
            }
            .onFailure {
                statsMessage.value = "Could not delete the custom entry. Try again."
                status.value = statsMessage.value
            }
    }

    fun createProgram(p: StrengthProgram) = viewModelScope.launch {
        runCatching { repo.createProgram(p) }
            .onSuccess { routines.value = repo.routines(); status.value = "✓ Added ${p.days.size} routines from “${p.name}”"; requestSync() }
            .onFailure { status.value = "Couldn't create program: ${it.message}" }
    }

    fun importCsv(text: String) = viewModelScope.launch {
        loading.value = true
        runCatching { repo.importCsv(text) }
            .onSuccess { s ->
                status.value = if (s.ok)
                    "✓ Imported ${s.workoutsAdded} ${s.format} workouts (${s.setsAdded} sets)" +
                        (if (s.duplicatesSkipped > 0) " · ${s.duplicatesSkipped} already there" else "")
                else "Import failed: ${s.error}"
                loadHome()
            }
            .onFailure { status.value = "Import failed: ${it.message}" }
        loading.value = false
    }

    // --- session lifecycle -------------------------------------------------
    private fun reset() {
        exercises.clear()
        workoutName = "Workout"
        workoutNote = ""
        editingWorkoutId = null
        editingEndedAt = 0L
        linkedPlannedId = null
        prescribedTargets = false
        linkedPlannedDate = null
        startedAt = System.currentTimeMillis()
        elapsedSec.value = 0
        stopRest()
        clearSavedSession()
    }

    // Q4: reorder exercises in the active session (drag-and-drop).
    fun moveExerciseTo(from: Int, to: Int) {
        if (from == to || from !in exercises.indices || to !in exercises.indices) return
        exercises.add(to, exercises.removeAt(from))
        persistSession()
    }

    // Q2: open an already-logged workout in the editor; finishing re-saves it in place.
    fun editWorkout(id: String) = viewModelScope.launch {
        val pair = repo.workoutWithSets(id) ?: run { status.value = "Workout not found"; return@launch }
        val (w, sets) = pair
        reset()
        editingWorkoutId = w.id
        editingEndedAt = w.endedAt
        startedAt = w.startedAt
        workoutName = w.name
        workoutNote = w.note
        linkedPlannedId = w.plannedWorkoutId
        sets.groupBy { it.exerciseName }.forEach { (name, group) ->
            val ux = UiExercise(name).apply { quantityUnit = group.firstOrNull()?.quantityUnit ?: "reps" }
            group.sortedBy { it.idx }.forEach { s ->
                ux.sets.add(UiSet(weight = kg(s.weightKg), reps = s.reps.toString(),
                    rpe = s.rpe?.toString() ?: "", done = true, warmup = s.isWarmup, note = s.note))
            }
            exercises.add(ux)
            launch { ux.previous = repo.previousSets(name) }
        }
        workoutDetail.value = null
        nav.value = StrengthNav.Active
        startTick()
        // Persist right away so the edit session survives process death / the
        // ViewModel being recreated by tab navigation.
        persistSession()
    }

    // Q8: save a logged workout as a reusable routine.
    fun saveWorkoutAsRoutine(id: String) = viewModelScope.launch {
        runCatching { repo.saveWorkoutAsRoutine(id) }
            .onSuccess { name ->
                routines.value = repo.routines()
                status.value = if (name != null) "✓ Saved “$name” as a routine" else "Nothing to save"
                requestSync()
            }
            .onFailure { status.value = "Couldn't save routine: ${it.message}" }
    }

    fun startEmpty() { reset(); nav.value = StrengthNav.Active; startTick() }

    fun startFromRoutine(r: RoutineWithItems) {
        reset()
        workoutName = r.routine.name
        r.items.sortedBy { it.position }.forEach { addExercise(it.exerciseName, it.targetSets) }
        nav.value = StrengthNav.Active
        startTick()
        persistSession()
    }

    fun cancelWorkout() { stopTick(); reset(); nav.value = StrengthNav.Home }
    fun openPicker() { replaceTarget.value = null; nav.value = StrengthNav.Picker; loadPicker() }
    fun backToActive() { replaceTarget.value = null; nav.value = StrengthNav.Active }
    fun goHome() { nav.value = StrengthNav.Home; loadHome() }

    // --- replace an exercise mid-session (hamburger → "Replace exercise") ---
    // The picker opens in single-select mode; the chosen exercise takes over the
    // slot, keeping everything already typed/ticked.
    val replaceTarget = MutableStateFlow<UiExercise?>(null)

    fun openPickerForReplace(ux: UiExercise) {
        replaceTarget.value = ux
        nav.value = StrengthNav.Picker
        loadPicker()
    }

    fun replaceExercise(newName: String) {
        val target = replaceTarget.value
        replaceTarget.value = null
        nav.value = StrengthNav.Active
        val i = target?.let { exercises.indexOf(it) } ?: -1
        if (target == null || i < 0) return
        val ux = UiExercise(newName)
        // Keep the athlete's entered sets; drop the old exercise's suggestions.
        target.sets.forEach { s -> ux.sets.add(UiSet(s.weight, s.reps, s.rpe, s.done, s.warmup, s.note)) }
        if (ux.sets.isEmpty()) ux.sets.add(UiSet())
        exercises[i] = ux
        viewModelScope.launch {
            ux.previous = repo.previousSets(newName)
            applySuggestion(ux, repo.progressionFor(newName))
        }
        persistSession()
    }

    fun addExercise(name: String, targetSets: Int = 1) {
        val ux = UiExercise(name)
        // Use the user's default rest for exercises the catalog has no value for.
        if (ExerciseCatalog.find(name) == null) ux.restSec = cfg.defaultRestSec
        repeat(targetSets.coerceAtLeast(1)) { ux.sets.add(UiSet()) }
        exercises.add(ux)
        viewModelScope.launch {
            ux.previous = repo.previousSets(name)
            // B1: prefill empty sets with the auto-progression target.
            applySuggestion(ux, repo.progressionFor(name))
        }
    }

    // E3: clone the most recent workout (exercises + last weights) into a new session.
    fun startFromLastWorkout() = viewModelScope.launch {
        val last = repo.lastWorkoutWithSets()
        if (last == null) { status.value = "No previous workout to repeat."; return@launch }
        reset()
        workoutName = last.first.name
        last.second.groupBy { it.exerciseName }.forEach { (name, sets) ->
            val ux = UiExercise(name)
            sets.sortedBy { it.idx }.forEach {
                ux.sets.add(UiSet(suggestedWeight = kg(it.weightKg), suggestedReps = it.reps.toString(), warmup = it.isWarmup))
            }
            exercises.add(ux)
            launch { ux.previous = repo.previousSets(name); applySuggestion(ux, repo.progressionFor(name)) }
        }
        nav.value = StrengthNav.Active
        startTick()
        persistSession()
    }

    // B3: generate today's strength session with the AI, then open it pre-filled.
    fun generateAiLift(durationMin: Int = 60) = viewModelScope.launch {
        loading.value = true
        status.value = "Generating today's lift with AI…"
        val w = runCatching { repo.generateAiStrength(durationMin) }.getOrNull()
        if (w == null || w.type != "strength" || w.sections.isEmpty()) {
            status.value = "AI couldn't build a strength session, check your provider key & profile."
        } else {
            reset()
            workoutName = w.title.ifBlank { "AI Strength" }
            seedFromWorkout(w)
            status.value = "✓ AI session ready, adjust and log"
            nav.value = StrengthNav.Active
            startTick()
            persistSession()
        }
        loading.value = false
    }

    // Pre-fill the active session from a structured Workout (AI lift or a plan).
    private fun seedFromWorkout(w: Workout) {
        prescribedTargets = true
        plannedExerciseGroups(w).forEach { group ->
            val first = group.doses.first().exercise
            if (ExerciseCatalog.find(group.name) == null && group.name.isNotBlank()) {
                viewModelScope.launch { runCatching {
                    repo.addCustomExercise(group.name, first.muscle ?: "Other", first.category ?: "Machine", first.compound ?: false)
                } }
            }
            val ux = UiExercise(group.name)
            group.doses.forEach { dose ->
                val e = dose.exercise
                ux.quantityUnit = when {
                    Regex("metres|meters|yards").containsMatchIn(e.reps) -> "metres"
                    Regex("sec|seconds").containsMatchIn(e.reps) -> "seconds"
                    ux.isCardio -> "minutes"
                    else -> ux.quantityUnit
                }
                repeat(e.sets.coerceAtLeast(1)) {
                    ux.sets.add(UiSet(
                        suggestedWeight = e.weight_kg?.let { kg(it) } ?: "",
                        suggestedReps = Regex("\\d+").find(e.reps)?.value ?: "",
                        warmup = dose.warmup,
                    ))
                }
                if (!dose.warmup) e.rest_seconds?.let { ux.restSec = it }
            }
            exercises.add(ux)
            // A prescribed recovery/familiarization load wins over a heavier
            // historical progression target. History is still visible as PREV.
            viewModelScope.launch { runCatching { ux.previous = repo.previousSets(group.name) } }
        }
    }

    // Open a planned calendar strength session in the logger, pre-filled and
    // linked so finishing marks the plan complete.
    private fun startPlanned(s: StrengthHandoff.Start) {
        reset()
        workoutName = displayWorkoutTitle(s.workout).ifBlank { "Planned Strength" }
        linkedPlannedId = s.plannedId
        linkedPlannedDate = s.date
        seedFromWorkout(s.workout)
        status.value = "Logging your planned session, tick sets as you go"
        nav.value = StrengthNav.Active
        startTick()
        persistSession()
    }

    fun addExercises(names: List<String>) {
        names.forEach { addExercise(it) }
        nav.value = StrengthNav.Active
        persistSession()
    }

    fun removeExercise(ux: UiExercise) { exercises.remove(ux); persistSession() }

    fun addSet(ux: UiExercise) {
        val last = ux.sets.lastOrNull()
        // Suggest the previous set's value (entered or its own suggestion) as a placeholder.
        ux.sets.add(UiSet(
            suggestedWeight = last?.weight?.ifBlank { last.suggestedWeight } ?: "",
            suggestedReps = last?.reps?.ifBlank { last.suggestedReps } ?: "",
        ))
        persistSession()
    }

    // Insert a warm-up ramp scaled from the working weight (greyed placeholders,
    // not logged until the athlete ticks them). Re-running replaces the existing
    // leading warm-ups instead of stacking. Cardio has no load → no ramp.
    fun addWarmupRamp(ux: UiExercise) {
        if (ux.isCardio) return
        val workKg = ux.sets.firstOrNull { !it.warmup }
            ?.let { it.weight.toDoubleOrNull() ?: it.suggestedWeight.toDoubleOrNull() }
            ?: ux.suggestion?.weightKg
            ?: ux.previous.maxOfOrNull { it.weightKg }
        if (workKg == null || workKg <= 0.0) {
            status.value = "Enter a working weight first to build a warm-up ramp"
            return
        }
        // Classic ramp: progressively heavier, fewer reps, toward the work set.
        val scheme = listOf(0.40 to 5, 0.60 to 3, 0.80 to 2)
        val rows = mutableListOf<Pair<Double, Int>>()
        for ((pct, reps) in scheme) {
            val w = roundToStep(workKg * pct, 2.5)
            if (w <= 0.0) continue
            if (rows.isNotEmpty() && kotlin.math.abs(rows.last().first - w) < 0.001) continue
            rows.add(w to reps)
        }
        if (rows.isEmpty()) { status.value = "Working weight is too light for a warm-up ramp"; return }
        // Drop any existing leading warm-ups so re-runs replace rather than stack.
        while (ux.sets.firstOrNull()?.warmup == true) ux.sets.removeAt(0)
        rows.reversed().forEach { (w, reps) ->
            ux.sets.add(0, UiSet(suggestedWeight = kg(w), suggestedReps = reps.toString(), warmup = true))
        }
        persistSession()
    }

    fun removeSet(ux: UiExercise, s: UiSet) { ux.sets.remove(s); persistSession() }

    fun setRest(ux: UiExercise, sec: Int) { ux.restSec = sec.coerceAtLeast(0); persistSession() }

    fun toggleDone(ux: UiExercise, s: UiSet) {
        if (!s.done) {
            // Ticking a blank field adopts its greyed suggestion — one tap logs
            // the suggested set as-is. The values become real (visible) entries
            // so what gets saved is exactly what the row shows.
            if (s.reps.isBlank() && s.suggestedReps.isNotBlank()) s.reps = s.suggestedReps
            if (!ux.isCardio && s.weight.isBlank() && s.suggestedWeight.isNotBlank()) s.weight = s.suggestedWeight
            // With no suggestion either, there's still nothing to log (0×0 guard).
            val needsWeight = ux.needsWeight && !s.warmup
            if (s.reps.isBlank() || (needsWeight && s.weight.isBlank())) {
                status.value = if (ux.isCardio) "Enter minutes before ticking the set"
                    else "Enter weight and reps before ticking the set"
                return
            }
            if (!s.warmup && ux.restSec > 0) startRest(ux.restSec)
        }
        s.done = !s.done
        persistSession()
    }

    // --- crash/kill-proof session persistence ------------------------------
    private val sessionFile: File get() = File(context.filesDir, "active_session.json")

    private var persistJob: Job? = null

    /** Coalesce edits; the revision guard also rejects writes already running
     * when a newer save or discard was requested. */
    fun persistSession() {
        val snapshot = snapshotSession()
        val revision = snapshotFile.nextRevision()
        persistJob?.cancel()
        persistJob = viewModelScope.launch(Dispatchers.IO) {
            delay(150)
            runCatching {
                snapshotFile.write(revision, snapshot?.let {
                    sessionJson.encodeToString(SavedSession.serializer(), it)
                })
            }.onFailure { Log.w("StrengthVM", "Session save failed", it) }
        }
    }

    private fun snapshotSession(): SavedSession? {
        if (nav.value != StrengthNav.Active || exercises.isEmpty()) return null
        val restEnd = if (restRemaining.value != null && restEndAt > System.currentTimeMillis()) restEndAt else null
        return SavedSession(
            workoutName = workoutName,
            workoutNote = workoutNote,
            startedAt = startedAt,
            linkedPlannedId = linkedPlannedId,
            prescribedTargets = prescribedTargets,
            linkedPlannedDate = linkedPlannedDate,
            editingWorkoutId = editingWorkoutId,
            editingEndedAt = editingEndedAt,
            restEndAt = restEnd,
            restTotal = restTotal.value,
            exercises = exercises.map { ux ->
                SavedExercise(ux.name, ux.restSec, ux.sets.map {
                    SavedSet(it.weight, it.reps, it.rpe, it.done, it.warmup, it.note, it.suggestedWeight, it.suggestedReps)
                }, ux.quantityUnit)
            },
        )
    }

    /**
     * Synchronous save for the critical moment the app is backgrounded/closing —
     * the debounced async [persistSession] can be cancelled when the process is
     * killed before its coroutine runs, so on ON_STOP we write on the spot.
     */
    fun persistSessionNow() {
        persistJob?.cancel()
        val revision = snapshotFile.nextRevision()
        val snapshot = snapshotSession()
        runCatching {
            snapshotFile.write(revision, snapshot?.let {
                sessionJson.encodeToString(SavedSession.serializer(), it)
            })
        }.onFailure { Log.w("StrengthVM", "Session save failed", it) }
    }

    private fun clearSavedSession() {
        persistJob?.cancel()
        val revision = snapshotFile.nextRevision()
        runCatching { snapshotFile.write(revision, null) }
            .onFailure { Log.w("StrengthVM", "Session clear failed", it) }
    }

    // Read synchronously in init (the file is tiny) so nav/exercises are set
    // BEFORE first composition — the app opens straight into the live session
    // with no Home→workout flash.
    private fun restoreSavedSession() {
        val saved = runCatching {
            if (sessionFile.exists()) sessionJson.decodeFromString(SavedSession.serializer(), sessionFile.readText()) else null
        }.getOrNull() ?: return
        if (saved.exercises.isEmpty()) { clearSavedSession(); return }
        if (nav.value == StrengthNav.Active && exercises.isNotEmpty()) return

        workoutName = saved.workoutName
        workoutNote = saved.workoutNote
        startedAt = saved.startedAt
        linkedPlannedId = saved.linkedPlannedId
        prescribedTargets = saved.prescribedTargets || saved.linkedPlannedId != null
        linkedPlannedDate = saved.linkedPlannedDate
        editingWorkoutId = saved.editingWorkoutId
        editingEndedAt = saved.editingEndedAt
        exercises.clear()
        saved.exercises.forEach { se ->
            val ux = UiExercise(se.name).apply { restSec = se.restSec; quantityUnit = se.quantityUnit }
            se.sets.forEach { ss ->
                ux.sets.add(UiSet(ss.weight, ss.reps, ss.rpe, ss.done, ss.warmup, ss.note, ss.suggestedWeight, ss.suggestedReps))
            }
            exercises.add(ux)
            viewModelScope.launch { runCatching { ux.previous = repo.previousSets(se.name); if (!prescribedTargets) applySuggestion(ux, repo.progressionFor(se.name)) } }
        }
        nav.value = StrengthNav.Active
        startTick()
        saved.restEndAt?.let { end ->
            val remain = ((end - System.currentTimeMillis()) / 1000).toInt()
            if (remain > 0) resumeRest(remain, saved.restTotal)
        }
        status.value = "Resumed your in-progress workout"
    }

    // --- timers ------------------------------------------------------------
    private fun startTick() {
        tickJob?.cancel()
        // Editing a past workout: freeze the clock at the session's original
        // duration — ticking from the old start would show days of "elapsed".
        if (isEditing) {
            elapsedSec.value = ((editingEndedAt - startedAt) / 1000).coerceAtLeast(0)
            return
        }
        // Keep the live session alive across backgrounding/swipe with a
        // foreground-service timer notification (like a watch workout).
        WorkoutForegroundService.start(context, workoutName, startedAt)
        tickJob = viewModelScope.launch {
            while (true) {
                elapsedSec.value = (System.currentTimeMillis() - startedAt) / 1000
                delay(1000)
            }
        }
    }
    private fun stopTick() {
        tickJob?.cancel(); tickJob = null
        WorkoutForegroundService.stop(context)
    }

    /** Manually start/restart a rest timer (the bottom "Rest" button). */
    fun startManualRest() = startRest(if (cfg.defaultRestSec > 0) cfg.defaultRestSec else 120)

    fun startRest(sec: Int) {
        if (sec <= 0) return
        restTotal.value = sec
        restEndAt = System.currentTimeMillis() + sec * 1000L
        restRemaining.value = sec
        scheduleRestAlarm(sec)
        runRestLoop()
        persistSession()
    }

    /** Resume a rest timer from a known remaining time (after restore). */
    private fun resumeRest(remaining: Int, total: Int) {
        restTotal.value = if (total > 0) total else remaining
        restEndAt = System.currentTimeMillis() + remaining * 1000L
        restRemaining.value = remaining
        scheduleRestAlarm(remaining)
        runRestLoop()
    }

    // Derive the countdown from the wall clock each tick, so a backgrounded /
    // throttled coroutine never makes the timer drift.
    private fun runRestLoop() {
        restJob?.cancel()
        restJob = viewModelScope.launch {
            var lastTicked = -1
            while (true) {
                val remain = Math.ceil((restEndAt - System.currentTimeMillis()) / 1000.0).toInt()
                if (remain <= 0) {
                    restRemaining.value = null
                    cancelRestAlarm() // foreground: cue in-app instead of via the alarm
                    if (cfg.restVibrate) vibrateStrong(context)
                    if (cfg.restNotify) playRestOverSound(context, cfg.restChime)
                    break
                }
                // Soft 3-2-1 ticks so the buzzer is a confirmation, not a jump
                // scare. Same gates as the cue itself: sound on + not silent.
                if (remain <= 3 && remain != lastTicked &&
                    cfg.restNotify && cfg.restChime != RestChime.SILENT
                ) {
                    lastTicked = remain
                    playCountdownTick(context)
                }
                restRemaining.value = remain
                delay(200) // smooth updates; value comes from the clock, not a decrement
            }
        }
    }

    fun adjustRest(delta: Int) {
        if (restRemaining.value == null) return
        restEndAt = (restEndAt + delta * 1000L).coerceAtLeast(System.currentTimeMillis())
        val next = Math.ceil((restEndAt - System.currentTimeMillis()) / 1000.0).toInt().coerceAtLeast(0)
        restRemaining.value = next
        if (delta > 0) restTotal.value = maxOf(restTotal.value, next)
        scheduleRestAlarm(next) // reschedule the backup alarm to the new end time
        persistSession()
    }
    fun skipRest() { restJob?.cancel(); restRemaining.value = null; restEndAt = 0L; cancelRestAlarm(); persistSession() }
    private fun stopRest() { restJob?.cancel(); restRemaining.value = null; restEndAt = 0L; cancelRestAlarm() }

    // Backup alarm so the "rest over" alert fires even if the app is killed.
    private fun restAlarmIntent(): PendingIntent {
        val i = Intent(context, RestAlarmReceiver::class.java)
        return PendingIntent.getBroadcast(
            context, 7001, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
    private fun scheduleRestAlarm(sec: Int) {
        if (!cfg.restNotify) return // user disabled rest-timer notifications
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val at = System.currentTimeMillis() + sec * 1000L
        try {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, restAlarmIntent())
        } catch (_: SecurityException) {
            am.set(AlarmManager.RTC_WAKEUP, at, restAlarmIntent())
        }
    }
    private fun cancelRestAlarm() {
        (context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager)?.cancel(restAlarmIntent())
    }

    // --- finish / routines / stats ----------------------------------------
    // Holds the finished workout between "Finish" and the Rate-your-effort screen,
    // since reset() clears the live session before the user rates it.
    private data class PendingFinish(
        val name: String,
        val started: Long,
        val ended: Long,
        val exercises: List<FinishedExercise>,
        val note: String,
        val editId: String?,
        val linkedId: String?,
    )
    private var pendingFinish: PendingFinish? = null

    fun finish() {
        val finished = exercises.map { ux ->
            FinishedExercise(
                name = ux.name,
                sets = ux.sets.filter { it.done }.map {
                    FinishedSet(
                        weightKg = it.weight.toDoubleOrNull() ?: 0.0,
                        reps = it.reps.toIntOrNull() ?: 0,
                        rpe = it.rpe.toIntOrNull(),
                        isWarmup = it.warmup,
                        note = it.note.trim(),
                        quantityUnit = ux.quantityUnit,
                    )
                },
            )
        }.filter { it.sets.isNotEmpty() }

        stopTick(); stopRest()
        val editId = editingWorkoutId
        val linkedId = linkedPlannedId
        if (finished.isEmpty()) { reset(); nav.value = StrengthNav.Home; status.value = "Discarded empty workout"; return }

        val started = startedAt
        // Keep the original end time when editing; otherwise stamp now.
        val ended = if (editId != null) editingEndedAt.coerceAtLeast(started) else System.currentTimeMillis()
        // Stash everything the save needs, then clear the live session and ask
        // the user to rate the session effort before we persist.
        pendingFinish = PendingFinish(workoutName, started, ended, finished, workoutNote.trim(), editId, linkedId)
        reset()
        nav.value = StrengthNav.RateEffort
    }

    /** Save the pending workout and (optionally) a session-RPE feedback row. */
    fun submitEffort(rpe: Int?, difficulty: String?) {
        val p = pendingFinish ?: run { nav.value = StrengthNav.Home; return }
        pendingFinish = null
        viewModelScope.launch {
            runCatching { repo.finishWorkout(p.name, p.started, p.ended, p.exercises, p.note, p.editId, p.linkedId) }
                .onSuccess { result ->
                    lastPrs.value = result.prs
                    // Auto-complete the linked plan so the calendar reflects it.
                    if (p.linkedId != null) runCatching { repo.markPlannedWorkoutDone(p.linkedId, true) }
                    status.value = when {
                        p.editId != null -> "✓ Workout updated"
                        p.linkedId != null -> "✓ Logged, planned session marked done"
                        result.prs.isEmpty() -> "✓ Workout saved"
                        else -> "✓ Saved · ${result.prs.size} new PR${if (result.prs.size > 1) "s" else ""}! 🎉"
                    }
                    // Push the session to the cloud now (not at next launch) so the
                    // AI generator sees today's work immediately.
                    requestSync()
                    // Durably submit the session effort + refresh memory — survives
                    // being offline at the gym or an app kill (WorkManager retries).
                    val date = Instant.ofEpochMilli(p.ended)
                        .atZone(ZoneId.systemDefault()).toLocalDate().toString()
                    FeedbackSyncWorker.request(
                        context, date, rpe, difficulty, p.note.ifBlank { null },
                        ownerUid = workoutRepo.auth.currentUserOrNull()?.id,
                    )
                }
                .onFailure { status.value = "Saved locally; sync failed: ${it.message}" }
            loadHome()
        }
        nav.value = StrengthNav.Home
    }

    /** Skip rating — still save the workout, just without a feedback row. */
    fun skipEffort() = submitEffort(null, null)

    fun saveAsRoutine() = viewModelScope.launch {
        if (exercises.isEmpty()) return@launch
        repo.saveRoutine(workoutName, exercises.map { it.name to it.sets.size })
        routines.value = repo.routines()
        status.value = "✓ Saved routine “$workoutName”"
        requestSync()
    }

    fun deleteRoutine(id: String) = viewModelScope.launch {
        repo.deleteRoutine(id)
        routines.value = repo.routines()
        requestSync()
    }

    // --- routine editing (long-press a routine) -----------------------------
    val editingRoutine = MutableStateFlow<RoutineWithItems?>(null)
    fun beginEditRoutine(r: RoutineWithItems) { editingRoutine.value = r }
    fun cancelEditRoutine() { editingRoutine.value = null }

    /** Persist an edited routine (renamed / reordered / changed items). */
    fun saveEditedRoutine(
        name: String,
        items: List<com.workoutmaker.app.strength.RoutineItemEntity>,
    ) = viewModelScope.launch {
        val current = editingRoutine.value ?: return@launch
        val cleanName = name.ifBlank { "Routine" }
        repo.updateRoutine(current.routine.copy(name = cleanName), items)
        routines.value = repo.routines()
        editingRoutine.value = null
        status.value = "✓ Updated “$cleanName”"
        requestSync()
    }

    fun deleteWorkout(id: String) = viewModelScope.launch {
        runCatching { repo.deleteWorkout(id) }
            .onSuccess {
                status.value = "Workout deleted"
                // If we were viewing this workout's detail, fall back to Home.
                if (nav.value is StrengthNav.WorkoutDetail) { workoutDetail.value = null; nav.value = StrengthNav.Home }
                loadHome()
            }
            .onFailure { status.value = "Couldn't delete: ${it.message}" }
    }

    // Loads stats for the dedicated exercise-stats page (a real NavHost
    // destination, not an internal `nav` state) — doesn't touch `nav`.
    fun openStats(name: String) = viewModelScope.launch { catalog.loadStats(name) }

    // --- push to Intervals.icu → watch (Zepp) ------------------------------
    private fun vibrate() {
        if (!cfg.restVibrate) return // user disabled rest-over vibration
        val vib = if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION") context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        runCatching { vib?.vibrate(VibrationEffect.createOneShot(450, VibrationEffect.DEFAULT_AMPLITUDE)) }
    }

    override fun onCleared() { stopTick(); stopRest() }
}
