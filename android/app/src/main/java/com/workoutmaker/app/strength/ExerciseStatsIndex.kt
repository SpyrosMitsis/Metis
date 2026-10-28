package com.workoutmaker.app.strength

/** Stats visibility never changes logged sets or merges differently named exercises. */
enum class ExerciseStatsFilter(val label: String) { ALL("All"), CUSTOM("Custom"), HIDDEN("Hidden") }

internal fun isCustomStatsEntry(name: String, customNames: Set<String>): Boolean =
    name in customNames || ExerciseCatalog.all.none { it.name == name }

internal fun exerciseStatsNames(
    names: List<String>, query: String, filter: ExerciseStatsFilter,
    hidden: Set<String>, customNames: Set<String>,
): List<String> = names.distinct().filter { name ->
    val visible = when (filter) {
        ExerciseStatsFilter.ALL -> name !in hidden
        ExerciseStatsFilter.CUSTOM -> name !in hidden && isCustomStatsEntry(name, customNames)
        ExerciseStatsFilter.HIDDEN -> name in hidden
    }
    val exercise = ExerciseCatalog.find(name)
    visible && listOfNotNull(name, exercise?.muscle, exercise?.category).any { it.contains(query.trim(), ignoreCase = true) }
}.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it })
