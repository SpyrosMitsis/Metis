package com.workoutmaker.app.strength

import com.workoutmaker.app.data.Workout
import com.workoutmaker.app.data.WorkoutExercise
import com.workoutmaker.app.data.WorkoutSection
import org.junit.Assert.*
import org.junit.Test

class PlannedExerciseGroupsTest {
    @Test fun warmupAndWorkingSetsStayOneExerciseWithSeparateDoses() {
        val warm = WorkoutExercise("Goblet Squat", 1, "6", weight_kg = null, rest_seconds = 30)
        val work = warm.copy(sets = 3, reps = "8", weight_kg = 12.0, rest_seconds = 90)
        val workout = Workout("strength", "Strength training", sections = listOf(
            WorkoutSection("warmup: Goblet Squat", exercises = listOf(warm)),
            WorkoutSection("main: Goblet Squat", exercises = listOf(work)),
            WorkoutSection("main: Side Plank", exercises = listOf(WorkoutExercise("Side Plank", 2, "20 sec"))),
        ))
        val groups = plannedExerciseGroups(workout)
        assertEquals(2, groups.size)
        assertEquals(listOf(true, false), groups[0].doses.map { it.warmup })
        assertEquals(4, groups[0].doses.sumOf { it.exercise.sets })
        assertEquals(null, groups[0].doses[0].exercise.weight_kg)
        assertEquals(12.0, groups[0].doses[1].exercise.weight_kg)
        assertEquals("20 sec", groups[1].doses.single().exercise.reps)
    }
    @Test fun prescribedTargetsSurviveAProcessRestartWithoutRequiringACalendarLink() {
        val saved = SavedSession(workoutName = "Coach workout", startedAt = 1, prescribedTargets = true)
        val encoded = sessionJson.encodeToString(SavedSession.serializer(), saved)
        assertTrue(sessionJson.decodeFromString(SavedSession.serializer(), encoded).prescribedTargets)
        assertFalse(sessionJson.decodeFromString(SavedSession.serializer(), "{\"workoutName\":\"Old session\",\"startedAt\":1}").prescribedTargets)
    }
    @Test fun legacyTitlesAreCleanedWithoutRenamingCustomWorkouts() {
        assertEquals("Strength training", displayWorkoutTitle(Workout("strength", "Strength: strength")))
        assertEquals("My recovery session", displayWorkoutTitle(Workout("strength", "My recovery session")))
    }
    @Test fun legacyWarmupNamesAndDifferentMovementsRemainDistinct() {
        val w = Workout("strength", "Legacy", sections = listOf(WorkoutSection("Warm-up", exercises = listOf(
            WorkoutExercise("Bench Press (Barbell)", 1, "5"), WorkoutExercise("Bench Press - Wide Grip (Barbell)", 1, "5"),
        ))))
        val groups = plannedExerciseGroups(w)
        assertEquals(2, groups.size)
        assertTrue(groups.all { it.doses.single().warmup })
    }
}
