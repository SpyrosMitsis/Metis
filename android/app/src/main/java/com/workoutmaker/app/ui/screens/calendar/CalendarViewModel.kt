package com.workoutmaker.app.ui.screens.calendar

import com.workoutmaker.app.util.runCatching

import androidx.compose.material.icons.filled.Sync
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.PlannedWorkout
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.data.CompletedActivity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import com.workoutmaker.app.data.AppPreferences
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate
import javax.inject.Inject
import com.workoutmaker.app.data.PlanChangeBus
import com.workoutmaker.app.data.PlanWeekRequest
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.data.WeekPlanRow
import com.workoutmaker.app.data.Workout
import com.workoutmaker.app.strength.SetEntity
import com.workoutmaker.app.strength.StrengthHandoff
import com.workoutmaker.app.strength.StrengthRepository
import com.workoutmaker.app.strength.WorkoutEntity
import java.time.Instant
import java.time.ZoneId
import com.workoutmaker.app.data.cachedPlannedWorkouts
import com.workoutmaker.app.data.completedActivities
import com.workoutmaker.app.data.deletePlannedWorkout
import com.workoutmaker.app.data.intervalsConnection
import com.workoutmaker.app.data.loadProfile
import com.workoutmaker.app.data.logManualActivity
import com.workoutmaker.app.data.markPlannedComplete
import com.workoutmaker.app.data.planWeek
import com.workoutmaker.app.data.plannedWorkouts
import com.workoutmaker.app.data.pushWorkout
import com.workoutmaker.app.data.requestSession
import com.workoutmaker.app.data.reschedulePlanned
import com.workoutmaker.app.data.savePlannedWorkout
import com.workoutmaker.app.data.setLocked
import com.workoutmaker.app.data.syncHealth
import com.workoutmaker.app.data.syncIntervals
import com.workoutmaker.app.data.undoSkip
import com.workoutmaker.app.data.weekPlan

@HiltViewModel
class CalendarViewModel @Inject constructor(
    private val repo: WorkoutRepository,
    private val strength: StrengthRepository,
    private val strengthHandoff: StrengthHandoff,
    private val planChanges: PlanChangeBus,
    private val prefs: AppPreferences,
) : ViewModel() {
    // Month or week, remembered across cold starts (see AppPreferences).
    val weekView = prefs.calendarWeekView.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    fun setWeekView(on: Boolean) = viewModelScope.launch { prefs.setCalendarWeekView(on) }

    // A date another screen asked the calendar to open on (chat's "view this
    // workout"). The screen consumes it once and clears it.
    val pendingFocusDate: MutableStateFlow<String?> get() = planChanges.focusDate
    fun consumeFocus() { planChanges.focusDate.value = null }

    // This VM outlives tab switches (saveState/restoreState), so without this
    // a coach-made plan change stayed invisible until a manual refresh.
    init {
        viewModelScope.launch {
            planChanges.changes.collect {
                load()
                lastWeekStart?.let { start -> loadWeekPlan(start) }
            }
        }
    }
    private var lastWeekStart: LocalDate? = null
    val workouts = MutableStateFlow<List<PlannedWorkout>>(emptyList())
    // For the phase strip on the week card (goal_date drives the phase bands).
    val profile = MutableStateFlow<TrainingProfile?>(null)
    val banner = MutableStateFlow<String?>(null)
    val loading = MutableStateFlow(false)
    val planning = MutableStateFlow(false)
    val weekPlan = MutableStateFlow<WeekPlanRow?>(null)
    // Q14: logged strength sessions, grouped by yyyy-MM-dd for the calendar.
    val strengthByDate = MutableStateFlow<Map<String, List<WorkoutEntity>>>(emptyMap())
    // Past activities from Intervals.icu, grouped by date for the calendar + detail.
    val activitiesByDate = MutableStateFlow<Map<String, List<CompletedActivity>>>(emptyMap())
    // Count of local strength changes (logged/edited/deleted offline) not yet
    // pushed to the cloud — surfaced as a banner so nothing looks lost.
    val pendingSync = MutableStateFlow(0)

    // Sets for a strength session opened from the calendar, keyed by workout id.
    val strengthSets = MutableStateFlow<Map<String, List<SetEntity>>>(emptyMap())
    fun loadStrengthSets(id: String) = viewModelScope.launch {
        if (strengthSets.value.containsKey(id)) return@launch
        runCatching { strength.setsForWorkout(id) }.onSuccess { strengthSets.value = strengthSets.value + (id to it) }
    }

    fun loadWeekPlan(start: LocalDate) = viewModelScope.launch {
        lastWeekStart = start
        weekPlan.value = repo.weekPlan(start.toString())
    }

    fun load() = viewModelScope.launch {
        loading.value = true
        if (profile.value == null) runCatching { repo.loadProfile() }.onSuccess { profile.value = it }
        val from = LocalDate.now().minusMonths(2).toString()
        runCatching { repo.plannedWorkouts(from) }
            .onSuccess { workouts.value = it }
            .onFailure {
                // Offline (incl. cold start): render the last cached plan.
                // Logged strength sessions below are local Room data anyway.
                val cached = repo.cachedPlannedWorkouts()
                if (cached.isNotEmpty() && workouts.value.isEmpty()) {
                    workouts.value = cached
                    banner.value = "Offline, showing your last synced plan."
                }
            }
        runCatching { repo.completedActivities(from) }
            .onSuccess { acts -> activitiesByDate.value = acts.filter { it.date != null }.groupBy { it.date!! } }
        runCatching {
            val zone = ZoneId.systemDefault()
            strength.recentWorkouts(500).groupBy {
                Instant.ofEpochMilli(it.startedAt).atZone(zone).toLocalDate().toString()
            }
        }.onSuccess { strengthByDate.value = it }
        runCatching { strength.pendingSyncCount() }.onSuccess { pendingSync.value = it }
        loading.value = false
    }

    // Pull the latest activities (Intervals.icu and/or Health Connect) so
    // actuals are current before adapting / reviewing the week.
    fun syncNow() = viewModelScope.launch {
        loading.value = true
        banner.value = "Syncing your latest activities…"
        runCatching { repo.syncHealth() }
        val hasIntervals = runCatching { repo.intervalsConnection() != null }.getOrDefault(false)
        if (hasIntervals) {
            runCatching { repo.syncIntervals() }
                .onSuccess { banner.value = "✓ Synced, your recent activities are up to date."; load() }
                .onFailure { banner.value = "Sync failed: ${it.message}" }
        } else {
            // No intervals connection: Health Connect was the sync.
            banner.value = "✓ Synced, your recent activities are up to date."
            load()
        }
        loading.value = false
    }

    fun markComplete(plannedId: String, date: LocalDate, completed: Boolean) = viewModelScope.launch {
        runCatching { repo.markPlannedComplete(plannedId, date.toString(), completed, if (completed) "just_right" else null, null) }
            .onSuccess { banner.value = if (completed) "✓ Marked done" else "Marked skipped"; load() }
            .onFailure { banner.value = it.message }
    }

    fun undoSkip(plannedId: String) = viewModelScope.launch {
        runCatching { repo.undoSkip(plannedId) }
            .onSuccess { banner.value = "Skip undone"; load() }
            .onFailure { banner.value = "Couldn't update: ${it.message}" }
    }

    // Undo a completion (in case of a mistake) — flips the flag without logging
    // feedback.
    fun markUndone(plannedId: String) = viewModelScope.launch {
        runCatching { repo.undoSkip(plannedId) }
            .onSuccess { banner.value = "Marked as not done"; load() }
            .onFailure { banner.value = "Couldn't update: ${it.message}" }
    }

    // Open a planned strength session in the Strength logger, pre-filled and
    // linked so finishing it marks this plan complete.
    fun logPlannedStrength(w: PlannedWorkout) {
        strengthHandoff.request(w.workout_json, w.id, w.date)
    }

    // Open a LOGGED strength session in the Strength logger's edit mode.
    fun editLoggedStrength(workoutId: String) {
        strengthHandoff.requestEdit(workoutId)
    }

    fun deletePlanned(plannedId: String) = viewModelScope.launch {
        runCatching { repo.deletePlannedWorkout(plannedId) }
            .onSuccess { banner.value = "Workout deleted"; load() }
            .onFailure { banner.value = "Couldn't delete: ${it.message}" }
    }

    fun logActivity(date: LocalDate, type: String, durationMin: Int, distanceKm: Double?, rpe: Int?) = viewModelScope.launch {
        runCatching { repo.logManualActivity(date.toString(), type, durationMin, distanceKm, rpe) }
            .onSuccess { banner.value = "✓ Logged $type session"; load() }
            .onFailure { banner.value = "Failed to log: ${it.message}" }
    }

    // #3: lock/unlock a session so the weekly re-planner leaves it fixed.
    fun toggleLock(w: PlannedWorkout) = viewModelScope.launch {
        runCatching { repo.setLocked(w.id, !w.locked) }
            .onSuccess { banner.value = if (!w.locked) "🔒 Locked, re-planning won't touch it" else "Unlocked"; load() }
            .onFailure { banner.value = "Couldn't update: ${it.message}" }
    }

    // #3: ask the AI for a fixed, locked-in session on a specific date from a
    // free-text request ("social 10k with friends").
    fun requestSession(date: LocalDate, request: String, type: String) = viewModelScope.launch {
        planning.value = true
        banner.value = "Building your locked-in session for $date…"
        runCatching { repo.requestSession(date.toString(), request, type) }
            .onSuccess { r ->
                banner.value = if (r.workout_id != null) "✓ Locked-in “${r.workout?.title ?: "session"}” on $date"
                else "AI couldn't build it, check your AI provider key in Settings."
                load()
            }
            .onFailure { banner.value = "Failed: ${it.message}" }
        planning.value = false
    }

    // E5: persist a manually-built structured session into the plan.
    fun saveBuiltWorkout(date: LocalDate, workout: Workout, push: Boolean) = viewModelScope.launch {
        banner.value = "Saving session…"
        runCatching {
            val id = repo.savePlannedWorkout(date.toString(), workout)
            if (push) runCatching { repo.pushWorkout(id) }
        }.onSuccess {
            banner.value = "✓ Added “${workout.title}” to $date" + (if (push) " · pushed to watch" else "")
            load()
        }.onFailure { banner.value = "Couldn't save: ${it.message}" }
    }

    // P7: move a planned workout to a new date.
    fun reschedule(plannedId: String, newDate: LocalDate) = viewModelScope.launch {
        runCatching { repo.reschedulePlanned(plannedId, newDate.toString()) }
            .onSuccess { banner.value = "Moved to $newDate"; load() }
            .onFailure { banner.value = "Couldn't move: ${it.message}" }
    }

    fun planWeek(start: LocalDate) = viewModelScope.launch {
        planning.value = true
        banner.value = "Planning your week from $start…"
        runCatching { repo.planWeek(PlanWeekRequest(start_date = start.toString())) }
            .onSuccess { r ->
                banner.value = r.error
                    ?: "✓ Planned ${r.scheduled}-day week (${r.week_focus ?: "block"})" +
                    (if (r.pushed > 0) " · pushed ${r.pushed} to watch" else "")
                load()
                loadWeekPlan(start)
            }
            .onFailure { banner.value = "Failed to plan week: ${it.message}" }
        planning.value = false
    }
}
