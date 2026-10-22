package com.workoutmaker.app.strength

import androidx.room.Dao
import androidx.room.Embedded
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Relation
import androidx.room.Transaction

// ============================================================================
// Local-first persistence for the strength module. The active session lives in
// the ViewModel; only finished workouts + routines are written here. Completed
// sessions are also pushed to Supabase strength_logs so the AI generator sees
// real volume / e1RM.
// ============================================================================

@Entity(tableName = "strength_workout")
data class WorkoutEntity(
    @PrimaryKey val id: String,
    val name: String,
    val startedAt: Long,
    val endedAt: Long,
    val durationSec: Int,
    val totalVolumeKg: Double,
    val note: String = "",
    // false ⇒ created/edited offline and not yet pushed to the cloud.
    val synced: Boolean = true,
)

@Entity(tableName = "strength_set")
data class SetEntity(
    @PrimaryKey val id: String,
    val workoutId: String,
    val exerciseName: String,
    val muscle: String,
    val idx: Int,            // set number within the exercise
    val weightKg: Double,
    val reps: Int,
    val rpe: Int? = null,
    val isWarmup: Boolean = false,
    val note: String = "",   // free-text per-set note (Q9; also imported from Strong's Notes column)
)

@Entity(tableName = "strength_routine")
data class RoutineEntity(
    @PrimaryKey val id: String,
    val name: String,
    val createdAt: Long,
    val synced: Boolean = true,
)

@Entity(tableName = "strength_routine_item")
data class RoutineItemEntity(
    @PrimaryKey val id: String,
    val routineId: String,
    val exerciseName: String,
    val position: Int,
    val targetSets: Int,
    val targetReps: String,
    val restSec: Int,
)

data class RoutineWithItems(
    @Embedded val routine: RoutineEntity,
    @Relation(parentColumn = "id", entityColumn = "routineId")
    val items: List<RoutineItemEntity>,
)

// User-created exercises (D1). Merged into the catalog at runtime.
@Entity(tableName = "strength_custom_exercise")
data class CustomExerciseEntity(
    @PrimaryKey val name: String,
    val muscle: String,
    val category: String,
    val compound: Boolean = false,
    val synced: Boolean = true,
)

// Picker favorites (D5). Device-local only — never synced.
@Entity(tableName = "strength_favorite")
data class FavoriteEntity(@PrimaryKey val name: String)

// Deletion that must still be propagated to the cloud once back online.
// tbl ∈ {"workout","routine","custom"}; rowId is the local primary key.
@Entity(tableName = "strength_tombstone", primaryKeys = ["tbl", "rowId"])
data class TombstoneEntity(val tbl: String, val rowId: String)

// Projection for charts: a set's working load paired with its workout date.
data class SetWithDate(
    val weightKg: Double,
    val reps: Int,
    val isWarmup: Boolean,
    val startedAt: Long,
)

// Richer projection (muscle + rpe + date) for weekly volume / deload analysis.
data class DatedSet(
    val exerciseName: String,
    val muscle: String,
    val weightKg: Double,
    val reps: Int,
    val rpe: Int?,
    val isWarmup: Boolean,
    val startedAt: Long,
)

@Dao
interface StrengthDao {
    // Account-scope wipe: local strength data belongs to ONE signed-in user;
    // these run together (see WorkoutRepository.clearLocalStrengthData) when
    // the device switches accounts so nothing leaks or cross-syncs.
    @Query("DELETE FROM strength_workout")
    suspend fun clearWorkouts()

    @Query("DELETE FROM strength_set")
    suspend fun clearSets()

    @Query("DELETE FROM strength_routine")
    suspend fun clearRoutines()

    @Query("DELETE FROM strength_routine_item")
    suspend fun clearRoutineItems()

    @Query("DELETE FROM strength_custom_exercise")
    suspend fun clearCustomExercises()

    @Query("DELETE FROM strength_favorite")
    suspend fun clearFavorites()

    @Query("DELETE FROM strength_tombstone")
    suspend fun clearTombstones()

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertWorkout(w: WorkoutEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSets(sets: List<SetEntity>)

    @Query("SELECT * FROM strength_workout ORDER BY startedAt DESC LIMIT :limit")
    suspend fun recentWorkouts(limit: Int = 50): List<WorkoutEntity>

    @Query("SELECT * FROM strength_workout WHERE id = :id")
    suspend fun workout(id: String): WorkoutEntity?

    // Best (heaviest) total-volume workout ever — for the session-volume PR.
    @Query("SELECT MAX(totalVolumeKg) FROM strength_workout")
    suspend fun bestWorkoutVolume(): Double?

    // Best total volume for one exercise within a single session (per-exercise volume PR).
    @Query(
        "SELECT MAX(v) FROM (SELECT workoutId, SUM(weightKg * reps) AS v FROM strength_set " +
            "WHERE exerciseName = :name AND isWarmup = 0 GROUP BY workoutId)",
    )
    suspend fun bestExerciseSessionVolume(name: String): Double?

    @Query("SELECT * FROM strength_set WHERE workoutId = :workoutId ORDER BY exerciseName, idx")
    suspend fun setsForWorkout(workoutId: String): List<SetEntity>

    // Existing workout start times — used to skip duplicates on CSV re-import.
    @Query("SELECT startedAt FROM strength_workout")
    suspend fun allStartedAts(): List<Long>

    // Workouts that ended after a timestamp — used to skip Health Connect
    // exercise sessions that were also logged in the app (double-count guard).
    @Query("SELECT * FROM strength_workout WHERE endedAt >= :since")
    suspend fun workoutsSince(since: Long): List<WorkoutEntity>

    @Query("DELETE FROM strength_workout WHERE id = :id")
    suspend fun deleteWorkout(id: String)

    @Query("DELETE FROM strength_set WHERE workoutId = :id")
    suspend fun deleteSetsForWorkout(id: String)

    // --- one-time custom-name cleanup -------------------------------------
    @Query("SELECT DISTINCT workoutId FROM strength_set WHERE exerciseName = :name")
    suspend fun workoutIdsForExercise(name: String): List<String>

    @Query("UPDATE strength_set SET exerciseName = :newName, muscle = :newMuscle WHERE exerciseName = :oldName")
    suspend fun renameSetExercise(oldName: String, newName: String, newMuscle: String)

    @Query("UPDATE strength_workout SET synced = 0 WHERE id = :id")
    suspend fun markWorkoutUnsynced(id: String)

    // The most recent prior workout that included this exercise (for "previous").
    @Query(
        """SELECT s.* FROM strength_set s
           JOIN strength_workout w ON s.workoutId = w.id
           WHERE s.exerciseName = :name AND s.isWarmup = 0
           ORDER BY w.startedAt DESC, s.idx ASC""",
    )
    suspend fun lastSetsForExercise(name: String): List<SetEntity>

    @Query(
        """SELECT s.weightKg AS weightKg, s.reps AS reps, s.isWarmup AS isWarmup,
                  w.startedAt AS startedAt
           FROM strength_set s JOIN strength_workout w ON s.workoutId = w.id
           WHERE s.exerciseName = :name
           ORDER BY w.startedAt ASC""",
    )
    suspend fun setsHistoryForExercise(name: String): List<SetWithDate>

    @Query("SELECT DISTINCT exerciseName FROM strength_set ORDER BY exerciseName")
    suspend fun loggedExercises(): List<String>

    // Most-recently-used exercises (for the picker's "Recent" section).
    @Query(
        """SELECT s.exerciseName FROM strength_set s
           JOIN strength_workout w ON s.workoutId = w.id
           GROUP BY s.exerciseName ORDER BY MAX(w.startedAt) DESC LIMIT :limit""",
    )
    suspend fun recentExercises(limit: Int = 12): List<String>

    // All working+warmup sets since a timestamp, with muscle/rpe/date — feeds
    // weekly volume (B5) and deload analysis (B2).
    @Query(
        """SELECT s.exerciseName AS exerciseName, s.muscle AS muscle, s.weightKg AS weightKg,
                  s.reps AS reps, s.rpe AS rpe, s.isWarmup AS isWarmup, w.startedAt AS startedAt
           FROM strength_set s JOIN strength_workout w ON s.workoutId = w.id
           WHERE w.startedAt >= :since ORDER BY w.startedAt""",
    )
    suspend fun datedSetsSince(since: Long): List<DatedSet>

    // --- custom exercises (D1) --------------------------------------------
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertCustomExercises(list: List<CustomExerciseEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertCustomExercise(e: CustomExerciseEntity)

    @Query("SELECT * FROM strength_custom_exercise ORDER BY name")
    suspend fun customExercises(): List<CustomExerciseEntity>

    @Query("DELETE FROM strength_custom_exercise WHERE name = :name")
    suspend fun deleteCustomExercise(name: String)

    // --- favorites (D5) ----------------------------------------------------
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun addFavorite(f: FavoriteEntity)

    @Query("DELETE FROM strength_favorite WHERE name = :name")
    suspend fun removeFavorite(name: String)

    @Query("SELECT name FROM strength_favorite ORDER BY name")
    suspend fun favorites(): List<String>

    // --- offline sync queue ------------------------------------------------
    @Query("SELECT * FROM strength_workout WHERE synced = 0 ORDER BY startedAt")
    suspend fun unsyncedWorkouts(): List<WorkoutEntity>

    @Transaction
    suspend fun acknowledgeWorkout(snapshot: WorkoutEntity, sets: List<SetEntity>) {
        if (workout(snapshot.id) == snapshot && setsForWorkout(snapshot.id) == sets) {
            markWorkoutSynced(snapshot.id)
        }
    }

    @Query("UPDATE strength_workout SET synced = 1 WHERE id = :id")
    suspend fun markWorkoutSynced(id: String)

    @Transaction
    @Query("SELECT * FROM strength_routine WHERE synced = 0")
    suspend fun unsyncedRoutines(): List<RoutineWithItems>

    @Query("UPDATE strength_routine SET synced = 1 WHERE id = :id")
    suspend fun markRoutineSynced(id: String)

    @Query("SELECT * FROM strength_custom_exercise WHERE synced = 0")
    suspend fun unsyncedCustom(): List<CustomExerciseEntity>

    @Query("UPDATE strength_custom_exercise SET synced = 1 WHERE name = :name")
    suspend fun markCustomSynced(name: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTombstone(t: TombstoneEntity)

    @Query("SELECT * FROM strength_tombstone")
    suspend fun tombstones(): List<TombstoneEntity>

    @Query("DELETE FROM strength_tombstone WHERE tbl = :tbl AND rowId = :id")
    suspend fun deleteTombstone(tbl: String, id: String)

    @Query(
        """SELECT (SELECT COUNT(*) FROM strength_workout WHERE synced = 0)
                + (SELECT COUNT(*) FROM strength_routine WHERE synced = 0)
                + (SELECT COUNT(*) FROM strength_custom_exercise WHERE synced = 0)
                + (SELECT COUNT(*) FROM strength_tombstone)""",
    )
    suspend fun pendingSyncCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertRoutine(r: RoutineEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertRoutineItems(items: List<RoutineItemEntity>)

    @Transaction
    @Query("SELECT * FROM strength_routine ORDER BY createdAt DESC")
    suspend fun routines(): List<RoutineWithItems>

    @Query("DELETE FROM strength_routine WHERE id = :id")
    suspend fun deleteRoutine(id: String)

    @Query("DELETE FROM strength_routine_item WHERE routineId = :id")
    suspend fun deleteRoutineItems(id: String)
}
