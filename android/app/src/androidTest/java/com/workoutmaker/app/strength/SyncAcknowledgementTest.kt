package com.workoutmaker.app.strength

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.workoutmaker.app.data.AppDatabase
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SyncAcknowledgementTest {
    @Test fun editsAndDeletionDuringUploadAreNotAcknowledged() = runBlocking {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), AppDatabase::class.java).build()
        try {
            val dao = db.strengthDao()
            val captured = WorkoutEntity("workout", "Original", 1, 2, 1, 100.0, synced = false)
            val set = SetEntity("set", captured.id, "Squat", "Quads", 1, 20.0, 5, 7, false)
            dao.insertWorkout(captured); dao.insertSets(listOf(set))
            // A note-only edit keeps all parent totals unchanged.
            dao.insertSets(listOf(set.copy(note = "new note")))
            dao.acknowledgeWorkout(captured, listOf(set))
            assertFalse(dao.workout(captured.id)!!.synced)
            val editedSets = dao.setsForWorkout(captured.id)
            dao.acknowledgeWorkout(captured, editedSets)
            assertTrue(dao.workout(captured.id)!!.synced)
            dao.deleteSetsForWorkout(captured.id); dao.deleteWorkout(captured.id)
            dao.acknowledgeWorkout(captured, editedSets)
            assertNull(dao.workout(captured.id))
        } finally { db.close() }
    }
}
