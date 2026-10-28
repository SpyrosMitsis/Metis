package com.workoutmaker.app.strength

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

// --- Active-session UI state (Compose-observable holders) -------------------
// File-scoped so it's available no matter when the VM's init runs (the restore
// init block executes before class-level vals would be initialized).
internal val sessionJson = Json { ignoreUnknownKeys = true }

// --- Crash/kill-proof snapshot of the in-progress session -------------------
@Serializable
internal data class SavedSet(
    val weight: String = "", val reps: String = "", val rpe: String = "",
    val done: Boolean = false, val warmup: Boolean = false, val note: String = "",
    val suggestedWeight: String = "", val suggestedReps: String = "",
)

@Serializable
internal data class SavedExercise(val name: String, val restSec: Int, val sets: List<SavedSet>, val quantityUnit: String = "reps")

@Serializable
internal data class SavedSession(
    val workoutName: String,
    val workoutNote: String = "",
    val startedAt: Long,
    val linkedPlannedId: String? = null,
    val prescribedTargets: Boolean = false,
    val linkedPlannedDate: String? = null,
    val editingWorkoutId: String? = null,
    val editingEndedAt: Long = 0L,
    val restEndAt: Long? = null, // absolute epoch ms the current rest ends
    val restTotal: Int = 0,
    val exercises: List<SavedExercise> = emptyList(),
)
