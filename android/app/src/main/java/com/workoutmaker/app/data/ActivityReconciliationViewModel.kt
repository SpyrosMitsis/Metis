package com.workoutmaker.app.data

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.util.runCatching
import dagger.hilt.android.lifecycle.HiltViewModel
import java.time.LocalDate
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

@HiltViewModel
class ActivityReconciliationViewModel @Inject constructor(private val repo: WorkoutRepository, private val planChanges: PlanChangeBus) : ViewModel() {
    data class State(
        val sourceId: String = "",
        val activity: CompletedActivity? = null,
        val plans: List<PlannedWorkout> = emptyList(),
        val activities: List<CompletedActivity> = emptyList(),
        val planId: String = "", val groupId: String = "", val duplicateId: String = "", val unmergeId: String = "",
        val actualType: String = "", val status: String = "unknown",
        val editing: Boolean = false, val loading: Boolean = false, val saving: Boolean = false,
        val needsSync: Boolean = false, val message: String? = null,
    ) {
        val canSave: Boolean get() = activity?.let { persistedActivityId(it.id) } == true && !loading && !saving &&
            actualType.isNotBlank() && (status !in listOf("completed_as_planned", "modified", "substituted") || planId.isNotEmpty())
    }
    val state = MutableStateFlow(State())
    private var loadVersion = 0

    private fun initial(activity: CompletedActivity) = State(sourceId = activity.id, activity = activity,
        planId = activity.planned_workout_id.orEmpty(), groupId = activity.session_group_id.orEmpty(),
        duplicateId = activity.duplicate_of.orEmpty(), actualType = activity.type.orEmpty(), status = activity.session_state)

    // Viewing a session never prompts for confirmation or fetches editor data.
    fun load(activity: CompletedActivity) { loadVersion++; state.value = initial(activity) }
    fun cancel() { loadVersion++; val old = state.value; old.activity?.let { state.value = initial(it).copy(sourceId = old.sourceId) } }

    fun edit(activity: CompletedActivity, sync: Boolean = false) = viewModelScope.launch {
        val version = ++loadVersion
        state.value = state.value.copy(loading = true, message = null)
        val result = runCatching {
            if (sync) repo.syncIntervals()
            val day = LocalDate.parse(activity.date)
            val candidates = repo.completedActivities(day.minusDays(1).toString())
            val resolved = resolveActivity(activity, candidates)
                ?: return@runCatching null
            val plans = repo.plannedWorkouts(day.minusDays(1).toString()).filter { it.date <= day.plusDays(1).toString() && !it.skipped && it.type != "rest" }
            initial(resolved).copy(sourceId = activity.id, editing = true, plans = plans,
                activities = candidates.filter { it.id != resolved.id && it.date != null && it.date <= day.plusDays(1).toString() })
        }
        if (version != loadVersion) return@launch
        state.value = result.fold({ it ?: state.value.copy(loading = false, needsSync = true, message = "This activity hasn't fully synced yet. Sync it before editing.") },
            { state.value.copy(loading = false, message = "Could not load the activity. Check your connection and try again.") })
    }

    fun correct() = viewModelScope.launch {
        val old = state.value
        if (!old.canSave) return@launch
        val activity = old.activity ?: return@launch
        val version = loadVersion
        state.value = old.copy(saving = true, message = null)
        val result = runCatching {
            repo.correctSession(activity.id, old.planId.ifEmpty { null }, old.status, old.actualType,
                old.duplicateId.ifEmpty { null }, old.groupId.ifEmpty { null }, activity.content_revision,
                old.unmergeId.ifEmpty { null })
        }
        if (version != loadVersion) return@launch
        state.value = result.fold({
            planChanges.emit("activity-correction")
            initial(activity.copy(type = old.actualType, planned_workout_id = old.planId.ifEmpty { null },
                session_state = old.status, link_source = "athlete", duplicate_of = old.duplicateId.ifEmpty { null },
                session_group_id = old.groupId.ifEmpty { null })).copy(sourceId = old.sourceId, message = "Changes saved.")
        }, { old.copy(saving = false, message = activityCorrectionError(it)) })
    }
}
