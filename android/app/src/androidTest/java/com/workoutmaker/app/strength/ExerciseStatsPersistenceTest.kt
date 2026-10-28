package com.workoutmaker.app.strength

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.workoutmaker.app.data.AppDatabase
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class ExerciseStatsPersistenceTest {
    @Test fun summariesCountSessionsRatherThanSetsAndSurviveCustomDefinitionDeletion() = runBlocking {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), AppDatabase::class.java).build()
        try {
            val dao = db.strengthDao()
            dao.insertWorkout(WorkoutEntity("first", "First", 1000, 2000, 1, 100.0))
            dao.insertWorkout(WorkoutEntity("second", "Second", 3000, 4000, 1, 100.0))
            val name = "Custom press"
            dao.insertCustomExercise(CustomExerciseEntity(name, "Chest", "Dumbbell"))
            val set = SetEntity("one", "first", name, "Chest", 1, 20.0, 5)
            dao.insertSets(listOf(set, set.copy(id = "two", idx = 2), set.copy(id = "three", workoutId = "second")))
            val expected = listOf(ExerciseLogSummary(name, 2, 3000))
            assertEquals(expected, dao.exerciseLogSummaries())
            dao.deleteCustomExercise(name)
            assertEquals(expected, dao.exerciseLogSummaries())
            assertEquals(2, dao.setsForWorkout("first").size)
            assertEquals(listOf(name), dao.loggedExercises())
        } finally { db.close() }
    }
}
