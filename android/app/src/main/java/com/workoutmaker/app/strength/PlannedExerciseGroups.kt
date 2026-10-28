package com.workoutmaker.app.strength

import com.workoutmaker.app.data.Workout
import com.workoutmaker.app.data.WorkoutExercise

/** Presentation/import grouping only. The executable prescription stays intact. */
data class PlannedExerciseDose(val exercise: WorkoutExercise, val warmup: Boolean)
data class PlannedExerciseGroup(val name: String, val doses: List<PlannedExerciseDose>)

fun plannedExerciseGroups(workout: Workout): List<PlannedExerciseGroup> {
    val groups = linkedMapOf<String, MutableList<PlannedExerciseDose>>()
    workout.sections.forEach { section ->
        val warmup = Regex("^(warm.?up|activation)\\b", RegexOption.IGNORE_CASE).containsMatchIn(section.name.trim())
        section.exercises.forEach { exercise ->
            groups.getOrPut(exercise.name) { mutableListOf() }.add(PlannedExerciseDose(exercise, warmup))
        }
    }
    return groups.map { (name, doses) -> PlannedExerciseGroup(name, doses) }
}

/** Keep custom titles intact while cleaning older machine-generated names. */
fun displayWorkoutTitle(workout: Workout): String = when (workout.title.lowercase()) {
    "strength: strength" -> "Strength training"
    "strength: hypertrophy" -> "Muscle-building strength"
    "run: easy" -> "Easy run"
    "ride: easy" -> "Easy ride"
    "swim: easy" -> "Easy swim"
    "recovery: rest" -> "Rest day"
    else -> workout.title
}
