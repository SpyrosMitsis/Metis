package com.workoutmaker.app.strength

import dagger.hilt.android.scopes.ViewModelScoped
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject

// Exercise catalog state for the Strength tab: picker data (favorites/recents/
// custom exercises) and per-exercise stats. Extracted out of StrengthViewModel
// because these are genuinely self-contained — no cross-references to
// nav/session/rest-timer/status, just reads/writes of their own state plus
// one-way calls into StrengthRepository.
//
// @ViewModelScoped (not @Singleton): this state is exclusive to one Strength
// tab instance and must NOT survive a logout/account switch the way a true
// app-wide singleton would.
//
// Deliberately does NOT hold nav, session persistence, the rest timer, or
// `status` — those are fused by design (crash-proof session restore snapshots
// session + rest-timer state together) and StrengthViewModel keeps owning them
// directly. See the note above `sealed interface StrengthNav` in
// StrengthViewModel.kt for the nav-vs-real-route seam this class has nothing
// to do with.
@ViewModelScoped
class StrengthCatalog @Inject constructor(
    private val repo: StrengthRepository,
) {
    private val _favorites = MutableStateFlow<List<String>>(emptyList())
    val favorites: StateFlow<List<String>> get() = _favorites

    private val _recentExercises = MutableStateFlow<List<String>>(emptyList())
    val recentExercises: StateFlow<List<String>> get() = _recentExercises

    private val _customExercises = MutableStateFlow<List<Exercise>>(emptyList())
    val customExercises: StateFlow<List<Exercise>> get() = _customExercises

    private val _currentStats = MutableStateFlow<ExerciseStats?>(null)
    val currentStats: StateFlow<ExerciseStats?> get() = _currentStats

    suspend fun loadPicker() {
        runCatching {
            repo.loadAndRegisterCustom()
            _favorites.value = repo.favorites()
            _recentExercises.value = repo.recentExercises()
            _customExercises.value = ExerciseCatalog.custom()
        }
    }

    suspend fun toggleFavorite(name: String) {
        val isFav = _favorites.value.contains(name)
        repo.toggleFavorite(name, !isFav)
        _favorites.value = repo.favorites()
    }

    /** Returns false (no-op) for a blank name so the caller can skip its status/sync side effects. */
    suspend fun addCustomExercise(name: String, muscle: String, category: String, compound: Boolean): Boolean {
        if (name.isBlank()) return false
        repo.addCustomExercise(name, muscle, category, compound)
        _customExercises.value = ExerciseCatalog.custom()
        return true
    }

    suspend fun deleteCustomExercise(name: String) {
        repo.deleteCustomExercise(name, hideFromStats = true)
        _customExercises.value = ExerciseCatalog.custom()
    }

    suspend fun loadStats(name: String) {
        _currentStats.value = repo.stats(name)
    }
}
