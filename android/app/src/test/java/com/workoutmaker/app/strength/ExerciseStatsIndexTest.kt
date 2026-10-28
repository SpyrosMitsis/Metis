package com.workoutmaker.app.strength

import org.junit.Assert.*
import org.junit.Test

class ExerciseStatsIndexTest {
    private val builtin = ExerciseCatalog.all.first().name
    private val imported = "Imported bench variation"
    private val custom = "My cable exercise"
    private val names get() = listOf(builtin, imported, custom)

    @Test fun hiddenCustomHistoryStaysAccessibleWithoutPollutingDefaultList() {
        val hidden = setOf(imported)
        assertEquals(setOf(builtin, custom), exerciseStatsNames(names, "", ExerciseStatsFilter.ALL, hidden, setOf(custom)).toSet())
        assertEquals(listOf(imported), exerciseStatsNames(names, "", ExerciseStatsFilter.HIDDEN, hidden, setOf(custom)))
        assertTrue(exerciseStatsNames(names, "", ExerciseStatsFilter.ALL, emptySet(), setOf(custom)).contains(imported))
    }

    @Test fun importedNamesCanBeManagedButBundledExercisesAreProtected() {
        assertFalse(isCustomStatsEntry(builtin, emptySet()))
        assertTrue(isCustomStatsEntry(imported, emptySet()))
        assertEquals(setOf(imported, custom), exerciseStatsNames(names, "", ExerciseStatsFilter.CUSTOM, emptySet(), setOf(custom)).toSet())
    }

    @Test fun searchIncludesMuscleAndEquipmentAndIgnoresCaseAndPadding() {
        val exercise = ExerciseCatalog.all.first()
        for (query in listOf(exercise.name.uppercase(), " ${exercise.muscle} ", exercise.category)) {
            assertEquals(listOf(exercise.name), exerciseStatsNames(listOf(exercise.name), query, ExerciseStatsFilter.ALL, emptySet(), emptySet()))
        }
    }

    @Test fun similarlyNamedVariantsRemainSeparateAndSortingIsStable() {
        val variants = listOf("Bench Press (Barbell)", "Barbell Bench Press", "Bench Press (Barbell)")
        assertEquals(listOf("Barbell Bench Press", "Bench Press (Barbell)"),
            exerciseStatsNames(variants, "", ExerciseStatsFilter.ALL, emptySet(), emptySet()))
    }
}
