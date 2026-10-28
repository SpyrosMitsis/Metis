package com.workoutmaker.app.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CacheReplacementTest {
    @Test fun scopedReplacePreservesHistoryAndRemovesDeletedWorkouts() = runBlocking {
        val db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(), AppDatabase::class.java,
        ).build()
        try {
            val dao = db.cacheDao()
            dao.upsertWorkouts(listOf(row("past", "2026-10-20"), row("deleted", "2026-10-21")))
            dao.replaceWorkoutsFrom("2026-10-21", listOf(row("new", "2026-10-22")))
            assertEquals(setOf("past", "new"), dao.workouts().map { it.id }.toSet())

            // A disk/constraint failure after the DELETE must roll it back.
            db.openHelper.writableDatabase.execSQL(
                "CREATE TRIGGER reject_cache_insert BEFORE INSERT ON cached_workout " +
                    "BEGIN SELECT RAISE(ABORT, 'test failure'); END",
            )
            assertTrue(runCatching {
                dao.replaceWorkoutsFrom("2026-10-21", listOf(row("failure", "2026-10-23")))
            }.isFailure)
            assertEquals(setOf("past", "new"), dao.workouts().map { it.id }.toSet())
        } finally {
            db.close()
        }
    }

    private fun row(id: String, date: String) = CachedWorkout(id, date, "run", "{}")
}
