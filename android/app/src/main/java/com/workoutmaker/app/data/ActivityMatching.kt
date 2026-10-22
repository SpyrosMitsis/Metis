package com.workoutmaker.app.data

// Sport compatibility is a matching hint; it does not verify the prescribed dose.
internal fun activityMatchesPlan(plannedType: String, actualType: String?): Boolean {
    val a = (actualType ?: "").lowercase()
    return when (plannedType.lowercase()) {
        "run" -> a.contains("run")
        "strength" -> a.contains("weight") || a.contains("strength") || a.contains("gym")
        "ride", "bike" -> a.contains("ride") || a.contains("bike") || a.contains("cycl")
        "swim" -> a.contains("swim")
        // rest + unknown planned types: never auto-complete from an activity.
        else -> false
    }
}
