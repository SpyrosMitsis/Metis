package com.workoutmaker.app.strength

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel

class UiSet(
    weight: String = "",
    reps: String = "",
    rpe: String = "",
    done: Boolean = false,
    warmup: Boolean = false,
    note: String = "",
    // AI / progression / repeat-last hints shown as greyed placeholders. They are
    // NOT logged values until the user accepts them (types, or taps the checkmark).
    suggestedWeight: String = "",
    suggestedReps: String = "",
) {
    var weight by mutableStateOf(weight)
    var reps by mutableStateOf(reps)
    var rpe by mutableStateOf(rpe)
    var done by mutableStateOf(done)
    var warmup by mutableStateOf(warmup)
    var note by mutableStateOf(note)
    var suggestedWeight by mutableStateOf(suggestedWeight)
    var suggestedReps by mutableStateOf(suggestedReps)

    // The athlete confirmed an outlier weight/reps for THIS set, so the sanity
    // dialog must not re-ask. Cleared whenever either field is edited again.
    var confirmedOdd by mutableStateOf(false)
}

class UiExercise(val name: String) {
    val muscle: String = ExerciseCatalog.muscleOf(name)
    var quantityUnit by mutableStateOf(if (ExerciseCatalog.isCardio(name)) "minutes" else ExerciseMetadataCatalog.byName[name]?.quantityUnit ?: "reps")
    val isBand: Boolean get() = ExerciseCatalog.find(name)?.category == "Band"
    val needsWeight: Boolean get() = !isCardio && !isBand && ExerciseCatalog.find(name)?.category != "Bodyweight"
    var restSec by mutableStateOf(ExerciseCatalog.restOf(name))
    val sets = mutableStateListOf<UiSet>()
    var previous by mutableStateOf<List<SetEntity>>(emptyList())
    var suggestion by mutableStateOf<ProgressionSuggestion?>(null) // B1 next-session target

    // Cardio entries log MINUTES (in the reps slot) and no weight.
    val isCardio: Boolean get() = ExerciseCatalog.isCardio(name)
}

// Format a kg value tersely (no trailing ".0").
internal fun kg(v: Double): String =
    if (kotlin.math.abs(v - v.toLong()) < 0.001) v.toLong().toString() else ((v * 100).toLong() / 100.0).toString()

// Single source of truth for the ↗ target headline and the greyed input placeholders:
// when a live progression suggestion exists it drives BOTH, so they can't
// disagree. Only fills sets the athlete hasn't typed into yet; a history-based
// suggestion overrides any plan-seeded placeholder.
internal fun applySuggestion(ux: UiExercise, sug: ProgressionSuggestion?) {
    ux.suggestion = sug
    if (sug == null || ux.quantityUnit != "reps" || ux.isBand) return
    ux.sets.forEach { s ->
        if (s.weight.isBlank()) s.suggestedWeight = kg(sug.weightKg)
        if (s.reps.isBlank()) s.suggestedReps = sug.reps.toString()
    }
}

// Internal pseudo-navigation WITHIN the Strength tab — distinct from the real
// Nav Compose routes in MainActivity.kt (home/coach/calendar/strength/
// settings, plus push routes like history/exercise-stats). Use a StrengthNav
// case when the transition must keep this ViewModel's live in-memory state
// mounted underneath it (an active workout, its rest timer, the mid-session
// exercise picker) — none of that survives being torn down and recreated.
//
// Use a real NavHost route instead when the destination should behave like an
// actual screen: the system back button pops just it, it gets its own
// back-stack entry, and (per the exercise-stats routes in MainActivity.kt)
// share THIS SAME StrengthViewModel instance via hiltViewModel(parentEntry)
// rather than letting Nav Compose spin up a fresh one — that reference is the
// pattern to copy for any new entry point.
//
// Getting this wrong is exactly what caused the "exercise stats opens as a
// popup" bug: one entry point (the workout-detail stats button) was migrated
// to a real NavHost route, but the picker dialog and the in-session bottom
// sheet weren't, so they kept behaving like modals until all three were
// aligned. Every new "go look at X" affordance in this tab should make this
// choice deliberately, not by copying whichever pattern happened to be
// closest in the file.
sealed interface StrengthNav {
    data object Home : StrengthNav
    data object Active : StrengthNav
    data object Picker : StrengthNav
    data class WorkoutDetail(val workoutId: String) : StrengthNav
    data object RateEffort : StrengthNav
}

// A logged workout opened in the detail page: header + sets grouped per exercise.
data class WorkoutDetailUi(
    val workout: WorkoutEntity,
    val exercises: List<Pair<String, List<SetEntity>>>,
    val totalSets: Int,
)
