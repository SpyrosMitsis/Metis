package com.workoutmaker.app.strength

import com.workoutmaker.app.util.runCatching

import androidx.room.withTransaction
import com.workoutmaker.app.data.AppDatabase
import com.workoutmaker.app.data.StrengthLogInsert
import com.workoutmaker.app.data.StrengthSet
import com.workoutmaker.app.data.WorkoutRepository
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.rpc
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.Serializable
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import android.util.Log
import com.workoutmaker.app.data.GenerateRequest
import com.workoutmaker.app.data.GenerateResult
import com.workoutmaker.app.data.Workout
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import com.workoutmaker.app.data.analyzeStrength
import com.workoutmaker.app.data.generateWorkout
import com.workoutmaker.app.data.logStrengthSet

// Domain types passed from the active-session ViewModel when a workout finishes.
data class FinishedSet(val weightKg: Double, val reps: Int, val rpe: Int?, val isWarmup: Boolean, val note: String = "")
data class FinishedExercise(val name: String, val sets: List<FinishedSet>)

// Cloud backup DTOs (timestamps are epoch millis to round-trip with Room).
// Every column except the primary/foreign keys is NULLABLE in the schema, so a
// row written with a missing value (e.g. a web-logged set with is_warmup null, or
// a workout with no note) must decode cleanly instead of throwing and taking the
// whole restore/merge down with it. Nulls are coalesced to safe defaults when
// mapped to Room (see toEntity below).
@Serializable
data class CloudWorkout(val id: String, val name: String? = null, val started_at: Long? = null, val ended_at: Long? = null, val duration_sec: Int? = null, val total_volume_kg: Double? = null, val note: String? = null)
@Serializable
data class CloudSet(val id: String, val workout_id: String, val exercise_name: String? = null, val muscle: String? = null, val idx: Int? = null, val weight_kg: Double? = null, val reps: Int? = null, val rpe: Int? = null, val is_warmup: Boolean? = null, val note: String? = null)
@Serializable
data class CloudRoutine(val id: String, val name: String? = null, val created_at: Long? = null)
@Serializable
data class CloudRoutineItem(val id: String, val routine_id: String, val exercise_name: String? = null, val position: Int? = null, val target_sets: Int? = null, val target_reps: String? = null, val rest_sec: Int? = null)

// Cloud -> Room, coalescing any null cloud values to safe defaults.
private fun CloudWorkout.toEntity(synced: Boolean = true) = WorkoutEntity(
    id, name ?: "Workout", started_at ?: 0L, ended_at ?: (started_at ?: 0L),
    duration_sec ?: 0, total_volume_kg ?: 0.0, note ?: "", synced,
)
private fun CloudSet.toEntity() = SetEntity(
    id, workout_id, exercise_name ?: "", muscle ?: "", idx ?: 0,
    weight_kg ?: 0.0, reps ?: 0, rpe, is_warmup ?: false, note ?: "",
)
private fun CloudRoutine.toEntity() = RoutineEntity(id, name ?: "Routine", created_at ?: 0L)
private fun CloudRoutineItem.toEntity() = RoutineItemEntity(
    id, routine_id, exercise_name ?: "", position ?: 0,
    target_sets ?: 3, target_reps ?: "8-12", rest_sec ?: 120,
)
@Serializable
data class CloudCustomExercise(val name: String, val muscle: String, val category: String, val compound: Boolean = false)

// Result of finishing a workout — surfaces any PRs hit for a celebration.
data class FinishResult(val workoutId: String, val prs: List<PrHit>)

// Outcome of a CSV import — drives the result dialog so the user sees exactly
// what landed (and what was intentionally left out).
data class ImportSummary(
    val ok: Boolean = true,
    val format: String = "CSV",
    val workoutsAdded: Int = 0,
    val duplicatesSkipped: Int = 0,
    val setsAdded: Int = 0,
    val cardioRowsSkipped: Int = 0,
    val unparsedRows: Int = 0,
    val error: String? = null,
)

// Weekly volume / balance / deload snapshot for the strength home (B2 + B5).
data class WeeklyReport(
    val muscleVolume: List<MuscleVolume>,
    val balance: List<BalanceWarning>,
    val deload: DeloadAdvice,
    val totalHardSets: Int,
)

@Singleton
class StrengthRepository @Inject constructor(
    private val dao: StrengthDao,
    private val cloud: WorkoutRepository,
    private val supabase: SupabaseClient,
    private val db: AppDatabase,
) {
    private val syncMutex = Mutex()
    suspend fun recentWorkouts(limit: Int = 50) = dao.recentWorkouts(limit)
    suspend fun setsForWorkout(id: String) = dao.setsForWorkout(id)
    suspend fun loggedExercises() = dao.loggedExercises()

    /** Most recent prior performance of an exercise, ordered by set index. */
    suspend fun previousSets(exercise: String): List<SetEntity> = cloud.withAccount {
        val rows = dao.lastSetsForExercise(exercise)
        val lastWorkout = rows.firstOrNull()?.workoutId ?: return@withAccount emptyList()
        return@withAccount rows.filter { it.workoutId == lastWorkout }.sortedBy { it.idx }
    }

    suspend fun stats(exercise: String): ExerciseStats =
        StrengthStats.compute(exercise, dao.setsHistoryForExercise(exercise))

    // --- mapping helpers ---------------------------------------------------
    private fun DatedSet.toLog() = LogSet(weightKg, reps, rpe, isWarmup, muscle, startedAt)
    private fun SetEntity.toLog() = LogSet(weightKg, reps, rpe, isWarmup, muscle, 0)
    private fun SetWithDate.toLog() = LogSet(weightKg, reps, null, isWarmup, "", startedAt)

    // --- B2 + B5: weekly volume / balance / deload -------------------------
    suspend fun weeklyReport(): WeeklyReport = cloud.withAccount {
        val now = System.currentTimeMillis()
        val week7 = dao.datedSetsSince(now - 7L * 86_400_000).map { it.toLog() }
        val weeks8 = dao.datedSetsSince(now - 56L * 86_400_000).map { it.toLog() }
        val mv = VolumeBalance.byMuscle(week7)
        return@withAccount WeeklyReport(
            muscleVolume = mv,
            balance = VolumeBalance.balance(mv),
            deload = Deload.analyze(Deload.weekly(weeks8)),
            totalHardSets = week7.count { !it.isWarmup && it.reps > 0 },
        )
    }

    // --- B1: next-session suggestion for an exercise -----------------------
    suspend fun progressionFor(exercise: String): ProgressionSuggestion? = cloud.withAccount {
        // Cardio is logged in minutes, not load — no strength progression target.
        if (ExerciseCatalog.isCardio(exercise)) return@withAccount null
        val last = previousSets(exercise).map { it.toLog() }
        if (last.isEmpty()) return@withAccount null
        val compound = ExerciseCatalog.find(exercise)?.compound ?: false
        val (lo, hi) = if (compound) 5 to 8 else 8 to 12
        return@withAccount Progression.suggest(last, ProgressionRule.DOUBLE, lo, hi, compound)
    }

    // --- E3: repeat last workout ------------------------------------------
    suspend fun lastWorkoutWithSets(): Pair<WorkoutEntity, List<SetEntity>>? = cloud.withAccount {
        val w = dao.recentWorkouts(1).firstOrNull() ?: return@withAccount null
        return@withAccount w to dao.setsForWorkout(w.id)
    }

    // Delete a logged workout locally; queue the cloud delete for the sync pass.
    // Transactional: a crash mid-sequence must not leave a workout without sets
    // or a delete without its tombstone.
    suspend fun deleteWorkout(id: String) = cloud.withAccount { db.withTransaction {
        dao.deleteSetsForWorkout(id)
        dao.deleteWorkout(id)
        dao.insertTombstone(TombstoneEntity("workout", id))
    } }

    // Swallowed errors are still logged so failures aren't invisible in logcat.
    private fun <T> Result<T>.logFailure(op: String): Result<T> =
        onFailure { Log.w("StrengthRepo", "$op failed", it) }

    // --- D1: custom exercises ---------------------------------------------
    suspend fun loadAndRegisterCustom() = cloud.withAccount {
        val local = dao.customExercises()
        ExerciseCatalog.registerCustom(local.map { Exercise(it.name, it.muscle, it.category, it.compound) })
    }

    suspend fun addCustomExercise(name: String, muscle: String, category: String, compound: Boolean) = cloud.withAccount {
        val e = CustomExerciseEntity(name.trim(), muscle, category, compound, synced = false)
        db.withTransaction {
            dao.deleteTombstone("custom", e.name)
            dao.insertCustomExercise(e)
        }
        loadAndRegisterCustom()
    }

    suspend fun deleteCustomExercise(name: String) = cloud.withAccount {
        db.withTransaction {
            dao.deleteCustomExercise(name)
            dao.insertTombstone(TombstoneEntity("custom", name))
        }
        loadAndRegisterCustom()
    }

    /**
     * One-off cleanup: any custom exercise that's really a reworded duplicate of
     * a bundled catalog exercise (e.g. "Machine Lat Pulldown" → "Lat Pulldown")
     * is renamed across every logged set — fixing the stored muscle too — and
     * dropped from the custom registry. Affected workouts are marked unsynced so
     * the next sync re-pushes their sets and rebuilds strength_logs with the
     * canonical names. Returns the number of customs collapsed.
     */
    suspend fun cleanupMislabeledCustoms(): Int = cloud.withAccount {
        var collapsed = 0
        for (c in dao.customExercises()) {
            val canon = ExerciseCatalog.canonicalFor(c.name) ?: continue
            if (canon.name == c.name) continue
            dao.workoutIdsForExercise(c.name).forEach { dao.markWorkoutUnsynced(it) }
            dao.renameSetExercise(c.name, canon.name, canon.muscle)
            deleteCustomExercise(c.name) // local delete + cloud tombstone
            collapsed++
        }
        if (collapsed > 0) loadAndRegisterCustom()
        return@withAccount collapsed
    }

    // --- D5: favorites + recents ------------------------------------------
    suspend fun favorites(): List<String> = dao.favorites()
    suspend fun recentExercises(limit: Int = 12): List<String> = dao.recentExercises(limit)
    suspend fun toggleFavorite(name: String, makeFavorite: Boolean) = cloud.withAccount {
        if (makeFavorite) dao.addFavorite(FavoriteEntity(name)) else dao.removeFavorite(name)
    }

    // --- B4: instantiate a program as routines ----------------------------
    suspend fun createProgram(program: StrengthProgram): Int = cloud.withAccount {
        for (day in program.days) {
            saveRoutine("${program.name}, ${day.name}", day.exercises)
        }
        return@withAccount program.days.size
    }

    // --- F2: CSV import ----------------------------------------------------
    suspend fun importCsv(text: String): ImportSummary = cloud.withAccount {
        val lineCount = text.count { it == '\n' } + 1
        val firstLine = text.lineSequence().firstOrNull()?.take(80) ?: ""
        Log.i("IMPORT", "read ${text.length} chars, ~$lineCount lines, header: $firstLine")
        val result = StrengthCsvImport.parse(text)
        Log.i("IMPORT", "parsed: format=${result.format} workouts=${result.workoutCount} sets=${result.setCount}")
        if (result.format == "unrecognized") {
            return@withAccount ImportSummary(ok = false, format = "unrecognized",
                error = "Couldn't recognise this file (read ${text.length} chars, $lineCount lines). " +
                    "Header was: “$firstLine”. Export a CSV from Strong or Hevy and try again.")
        }
        if (result.workouts.isEmpty()) {
            return@withAccount ImportSummary(ok = false, format = result.format,
                error = "Found the $lineCount-line file but no logged sets in it " +
                    "(${result.cardioRows} cardio, ${result.skippedRows} unreadable rows).",
                cardioRowsSkipped = result.cardioRows, unparsedRows = result.skippedRows)
        }
        // Skip workouts we already imported (same start time) so re-importing the
        // same export doesn't duplicate the entire history.
        val existing = dao.allStartedAts().toHashSet()
        var added = 0; var duplicates = 0; var setsAdded = 0
        for (w in result.workouts) {
            if (w.startedAt in existing) { duplicates++; continue }
            val workoutId = UUID.randomUUID().toString()
            val setEntities = mutableListOf<SetEntity>()
            var totalVolume = 0.0
            for (ex in w.exercises) {
                val muscle = ExerciseCatalog.muscleOf(ex.name)
                ex.sets.forEachIndexed { i, s ->
                    if (!s.isWarmup) totalVolume += s.weightKg * s.reps
                    setEntities.add(SetEntity(UUID.randomUUID().toString(), workoutId, ex.name, muscle, i + 1, s.weightKg, s.reps, s.rpe, s.isWarmup, s.note))
                }
            }
            val we = WorkoutEntity(workoutId, w.name, w.startedAt, w.startedAt, 0, totalVolume, "Imported", synced = false)
            db.withTransaction {
                dao.insertWorkout(we)
                if (setEntities.isNotEmpty()) dao.insertSets(setEntities)
            }
            existing.add(w.startedAt)
            added++; setsAdded += setEntities.size
        }
        Log.i("IMPORT", "inserted $added workouts ($setsAdded sets), skipped $duplicates dup; db now ${dao.allStartedAts().size}")
        return@withAccount ImportSummary(
            ok = true, format = result.format,
            workoutsAdded = added, duplicatesSkipped = duplicates, setsAdded = setsAdded,
            cardioRowsSkipped = result.cardioRows, unparsedRows = result.skippedRows,
        )
    }

    // Full detail for one logged workout (header + every set), for the detail page.
    suspend fun workoutWithSets(id: String): Pair<WorkoutEntity, List<SetEntity>>? = cloud.withAccount {
        val w = dao.workout(id) ?: return@withAccount null
        return@withAccount w to dao.setsForWorkout(id)
    }

    // Q8: turn a logged workout into a reusable routine (exercise → set count).
    suspend fun saveWorkoutAsRoutine(id: String): String? = cloud.withAccount {
        val (w, sets) = workoutWithSets(id) ?: return@withAccount null
        // Preserve exercise order and count working+warmup sets per exercise.
        val perExercise = LinkedHashMap<String, Int>()
        sets.forEach { perExercise[it.exerciseName] = (perExercise[it.exerciseName] ?: 0) + 1 }
        if (perExercise.isEmpty()) return@withAccount null
        saveRoutine(w.name, perExercise.toList())
        return@withAccount w.name
    }

    // Q11: export the entire strength history as a Strong-compatible CSV so it can
    // be re-imported here or anywhere else. Semicolon-delimited, matching Strong.
    suspend fun exportCsv(): String = cloud.withAccount {
        val sb = StringBuilder()
        sb.append("Date;Workout Name;Exercise Name;Set Order;Weight;Weight Unit;Reps;RPE;Notes\n")
        val fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
        val zone = ZoneId.systemDefault()
        fun q(s: String) = "\"" + s.replace("\"", "\"\"") + "\""
        for (w in dao.recentWorkouts(10_000)) {
            val date = Instant.ofEpochMilli(w.startedAt).atZone(zone).toLocalDateTime().format(fmt)
            val sets = dao.setsForWorkout(w.id)
            for (s in sets) {
                val weight = if (s.weightKg == s.weightKg.toLong().toDouble()) s.weightKg.toLong().toString()
                    else s.weightKg.toString()
                sb.append("$date;${q(w.name)};${q(s.exerciseName)};${s.idx};$weight;kg;${s.reps};${s.rpe ?: ""};${q(s.note)}\n")
            }
        }
        return@withAccount sb.toString()
    }

    suspend fun routines(): List<RoutineWithItems> = dao.routines()

    suspend fun saveRoutine(name: String, exercises: List<Pair<String, Int>>) = cloud.withAccount {
        val rid = UUID.randomUUID().toString()
        val createdAt = System.currentTimeMillis()
        val items = exercises.mapIndexed { i, (ex, sets) ->
            RoutineItemEntity(
                id = UUID.randomUUID().toString(),
                routineId = rid,
                exerciseName = ex,
                position = i,
                targetSets = sets,
                targetReps = "8-12",
                restSec = ExerciseCatalog.restOf(ex),
            )
        }
        db.withTransaction {
            dao.insertRoutine(RoutineEntity(rid, name.ifBlank { "Routine" }, createdAt, synced = false))
            dao.insertRoutineItems(items)
        }
    }

    // Edit an existing routine in place: keep its id (and createdAt), replace its
    // items. Marked unsynced so the next sync pushes the change.
    suspend fun updateRoutine(routine: RoutineEntity, items: List<RoutineItemEntity>) = cloud.withAccount { db.withTransaction {
        dao.deleteRoutineItems(routine.id)
        dao.insertRoutine(routine.copy(synced = false))
        dao.insertRoutineItems(items.mapIndexed { i, it -> it.copy(routineId = routine.id, position = i) })
    } }

    suspend fun deleteRoutine(id: String) = cloud.withAccount { db.withTransaction {
        dao.deleteRoutineItems(id)
        dao.deleteRoutine(id)
        dao.insertTombstone(TombstoneEntity("routine", id))
    } }

    // B3: ask the AI generator for a strength session (not pushed; the user logs it live).
    private val genJson = Json { ignoreUnknownKeys = true; isLenient = true }
    suspend fun generateAiStrength(durationMin: Int = 60): Workout? = cloud.withAccount {
        val raw = cloud.generateWorkout(
            GenerateRequest(type = "strength", duration = durationMin, push = false),
        )
        return@withAccount runCatching {
            genJson.decodeFromString(GenerateResult.serializer(), raw).workout
        }.logFailure("generateAiStrength/parse").getOrNull()
    }

    /** Flip a planned calendar workout's completed flag — used when a planned
     *  strength session is logged (or un-done) from the strength logger. */
    suspend fun markPlannedWorkoutDone(plannedId: String, done: Boolean) = cloud.withAccount {
        supabase.postgrest.from("planned_workouts")
            .update(mapOf("completed" to JsonPrimitive(done))) {
                filter { eq("id", plannedId) }
            }
    }

    /** Pull-merge: insert any cloud workouts we don't already have locally (e.g.
     *  sessions logged on the web app), and refresh ones EDITED elsewhere (the
     *  cloud row differs from a local copy with no pending local change).
     *  Unlike restoreIfEmpty this runs even when local history is non-empty,
     *  giving true two-way sync. Returns # merged in. */
    suspend fun mergeFromCloud(): Int = cloud.withAccount {
        syncMutex.withLock { mergeFromCloudOrThrow() }
    }

    private suspend fun mergeFromCloudOrThrow(): Int {
        val snapshot = supabase.postgrest.rpc("strength_snapshot",
            buildJsonObject { put("p_owner", cloud.uid()) }).decodeAs<StrengthCloudSnapshot>()
        return db.withTransaction {
            val deleted = dao.tombstones().groupBy { it.tbl }
                .mapValues { (_, rows) -> rows.map { it.rowId }.toSet() }
            val local = dao.recentWorkouts(Int.MAX_VALUE).associateBy { it.id }
            val incoming = snapshot.workouts.filter {
                it.id !in deleted["workout"].orEmpty() && local[it.id]?.synced != false
            }
            // A complete snapshot makes remote deletions distinguishable from
            // an incomplete page. Never remove pending local changes.
            val remoteIds = snapshot.workouts.map { it.id }.toSet()
            local.values.filter { it.synced && it.id !in remoteIds }.forEach {
                dao.deleteSetsForWorkout(it.id); dao.deleteWorkout(it.id)
            }
            incoming.forEach {
                dao.deleteSetsForWorkout(it.id)
                dao.insertWorkout(it.toEntity())
            }
            val incomingIds = incoming.map { it.id }.toSet()
            dao.insertSets(snapshot.sets.filter { it.workout_id in incomingIds }.map { it.toEntity() })
            val routines = dao.routines().associateBy { it.routine.id }
            val remoteRoutines = snapshot.routines.map { it.id }.toSet()
            routines.values.filter { it.routine.synced && it.routine.id !in remoteRoutines }.forEach {
                dao.deleteRoutineItems(it.routine.id); dao.deleteRoutine(it.routine.id)
            }
            val incomingRoutines = snapshot.routines.filter {
                it.id !in deleted["routine"].orEmpty() && routines[it.id]?.routine?.synced != false
            }
            incomingRoutines.forEach {
                dao.deleteRoutineItems(it.id); dao.insertRoutine(it.toEntity())
            }
            val routineIds = incomingRoutines.map { it.id }.toSet()
            dao.insertRoutineItems(snapshot.items.filter { it.routine_id in routineIds }.map { it.toEntity() })
            val customs = dao.customExercises().associateBy { it.name }
            val remoteNames = snapshot.custom.map { it.name }.toSet()
            customs.values.filter { it.synced && it.name !in remoteNames }.forEach { dao.deleteCustomExercise(it.name) }
            dao.insertCustomExercises(snapshot.custom.filter {
                it.name !in deleted["custom"].orEmpty() && customs[it.name]?.synced != false
            }.map { CustomExerciseEntity(it.name, it.muscle, it.category, it.compound) })
            ExerciseCatalog.registerCustom(dao.customExercises().map { Exercise(it.name,it.muscle,it.category,it.compound) })
            incoming.count { it.id !in local }
        }
    }

    /**
     * Persist a finished workout locally, then best-effort push each exercise to
     * Supabase strength_logs so the AI generator sees the real volume / e1RM.
     * Returns the new workout id.
     */
    suspend fun finishWorkout(
        name: String,
        startedAt: Long,
        endedAt: Long,
        exercises: List<FinishedExercise>,
        note: String = "",
        // Q2: when re-saving an edited workout, reuse its id (and delete the old
        // sets first) so the entry is updated in place rather than duplicated.
        existingId: String? = null,
    ): FinishResult = cloud.withAccount { db.withTransaction {
        // Transactional so an edit's delete-old + insert-new is atomic — a crash
        // between them would otherwise lose the workout entirely.
        // In edit mode, drop the old version first so PR detection and history
        // don't compare the session against its own prior copy.
        if (existingId != null) {
            dao.deleteSetsForWorkout(existingId)
            dao.deleteWorkout(existingId)
        }

        // C2: detect PRs against prior history BEFORE this session is persisted.
        // (In edit mode the old copy was just deleted, so it isn't compared against.)
        val priorBestWorkoutVolume = dao.bestWorkoutVolume() ?: 0.0
        val prHits = mutableListOf<PrHit>()
        for (ex in exercises) {
            val session = ex.sets.map { LogSet(it.weightKg, it.reps, it.rpe, it.isWarmup) }
            val working = session.filter { !it.isWarmup && it.reps > 0 }
            if (working.isEmpty()) continue
            val prior = Prs.record(dao.setsHistoryForExercise(ex.name).map { it.toLog() })
            Prs.detect(prior, session).forEach { prHits.add(PrHit(it.type, "${ex.name}: ${it.detail}")) }
            // Per-exercise session-volume PR: most total volume for this lift in one session.
            val exSessionVol = working.sumOf { it.weightKg * it.reps }
            val priorExVol = dao.bestExerciseSessionVolume(ex.name) ?: 0.0
            if (priorExVol > 0.0 && exSessionVol > priorExVol + 1e-6) {
                prHits.add(PrHit("volume", "${ex.name}: ${exSessionVol.toInt()} kg volume"))
            }
        }

        val workoutId = existingId ?: UUID.randomUUID().toString()
        val setEntities = mutableListOf<SetEntity>()
        var totalVolume = 0.0
        for (ex in exercises) {
            val muscle = ExerciseCatalog.muscleOf(ex.name)
            ex.sets.forEachIndexed { i, s ->
                if (!s.isWarmup) totalVolume += s.weightKg * s.reps
                setEntities.add(
                    SetEntity(
                        id = UUID.randomUUID().toString(),
                        workoutId = workoutId,
                        exerciseName = ex.name,
                        muscle = muscle,
                        idx = i + 1,
                        weightKg = s.weightKg,
                        reps = s.reps,
                        rpe = s.rpe,
                        isWarmup = s.isWarmup,
                        note = s.note,
                    ),
                )
            }
        }
        // Session-volume PR: the whole workout out-totals your previous best ever.
        // Shown first as the headline. Skipped for a first-ever workout.
        if (priorBestWorkoutVolume > 0.0 && totalVolume > priorBestWorkoutVolume + 1e-6) {
            prHits.add(0, PrHit("session_volume", "Biggest workout yet, ${totalVolume.toInt()} kg total"))
        }

        val durationSec = ((endedAt - startedAt) / 1000).toInt().coerceAtLeast(0)
        val workoutEntity = WorkoutEntity(
            id = workoutId,
            name = name.ifBlank { "Workout" },
            startedAt = startedAt,
            endedAt = endedAt,
            durationSec = durationSec,
            totalVolumeKg = totalVolume,
            note = note,
            synced = false, // pushed to the cloud by the next sync pass (works offline)
        )
        dao.insertWorkout(workoutEntity)
        if (setEntities.isNotEmpty()) dao.insertSets(setEntities)
        FinishResult(workoutId, prHits)
    } }

    // ========================================================================
    // Offline sync: drain everything created/deleted while offline. Called by
    // StrengthSyncWorker (network-constrained) so it runs the moment a
    // connection is available — even if the app was closed. Throws on network
    // failure so WorkManager retries with backoff.
    // ========================================================================
    suspend fun pendingSyncCount(): Int = dao.pendingSyncCount()

    suspend fun syncPending(): Int = cloud.withAccount {
        syncMutex.withLock {
            val captured = db.withTransaction {
                StrengthUpload(
                    dao.unsyncedWorkouts().map { it to dao.setsForWorkout(it.id) },
                    dao.unsyncedRoutines(), dao.unsyncedCustom(), dao.tombstones(),
                )
            }
            if (captured.isNotEmpty()) {
                supabase.postgrest.rpc("sync_strength", captured.payload(cloud.uid(), ZoneId.systemDefault().id))
                // Acknowledge exactly the snapshot sent, never a newer edit.
                db.withTransaction {
                    captured.workouts.forEach { (w, sets) ->
                        dao.acknowledgeWorkout(w, sets)
                    }
                    val routines = dao.routines().associateBy { it.routine.id }
                    captured.routines.forEach { r ->
                        if (routines[r.routine.id] == r) dao.markRoutineSynced(r.routine.id)
                    }
                    val customs = dao.customExercises().associateBy { it.name }
                    captured.custom.forEach { c ->
                        if (customs[c.name] == c) dao.markCustomSynced(c.name)
                    }
                    captured.deletes.forEach { dao.deleteTombstone(it.tbl, it.rowId) }
                }
            }
            mergeFromCloudOrThrow()
            captured.workouts.map { Instant.ofEpochMilli(it.first.startedAt).atZone(ZoneId.systemDefault()).toLocalDate().toString() }
                .distinct().forEach { date ->
                    runCatching { cloud.analyzeStrength(date, force = true) }.logFailure("syncPending/analyze")
                }
            dao.pendingSyncCount()
        }
    }
}

@Serializable
internal data class StrengthCloudSnapshot(
    val workouts: List<CloudWorkout>,
    val sets: List<CloudSet>,
    val routines: List<CloudRoutine>,
    val items: List<CloudRoutineItem>,
    val custom: List<CloudCustomExercise>,
)

private data class StrengthUpload(
    val workouts: List<Pair<WorkoutEntity, List<SetEntity>>>,
    val routines: List<RoutineWithItems>,
    val custom: List<CustomExerciseEntity>,
    val deletes: List<TombstoneEntity>,
) {
    fun isNotEmpty() = workouts.isNotEmpty() || routines.isNotEmpty() || custom.isNotEmpty() || deletes.isNotEmpty()
    fun payload(owner: String, zone: String): JsonObject {
        val json = Json { encodeDefaults = true }
        return buildJsonObject {
            put("p_owner", owner); put("p_zone", zone)
            put("p_workouts", JsonArray(workouts.map { (w, sets) ->
                JsonObject(json.encodeToJsonElement(CloudWorkout(w.id,w.name,w.startedAt,w.endedAt,w.durationSec,w.totalVolumeKg,w.note)).jsonObject +
                    ("sets" to json.encodeToJsonElement(sets.map {
                        CloudSet(it.id,it.workoutId,it.exerciseName,it.muscle,it.idx,it.weightKg,it.reps,it.rpe,it.isWarmup,it.note)
                    })))
            }))
            put("p_routines", JsonArray(routines.map { r ->
                JsonObject(json.encodeToJsonElement(CloudRoutine(r.routine.id,r.routine.name,r.routine.createdAt)).jsonObject +
                    ("items" to json.encodeToJsonElement(r.items.map {
                        CloudRoutineItem(it.id,it.routineId,it.exerciseName,it.position,it.targetSets,it.targetReps,it.restSec)
                    })))
            }))
            put("p_custom", json.encodeToJsonElement(custom.map { CloudCustomExercise(it.name,it.muscle,it.category,it.compound) }))
            put("p_deletes", JsonArray(deletes.map { buildJsonObject { put("tbl",it.tbl); put("rowId",it.rowId) } }))
        }
    }
}
