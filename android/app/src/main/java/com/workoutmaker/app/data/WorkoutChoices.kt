package com.workoutmaker.app.data

val workoutSports = linkedMapOf(
    "auto" to "Coach's choice", "run" to "Running", "ride" to "Cycling",
    "swim" to "Swimming", "strength" to "Strength",
)

fun workoutFocuses(sport: String): List<String> = when (sport) {
    "run" -> listOf("Easy run", "Recovery run", "Long run", "Strides", "Tempo", "Threshold", "Intervals", "Hills", "Run and walk")
    "ride" -> listOf("Easy ride", "Recovery ride", "Long ride", "Tempo", "Threshold", "Intervals")
    "swim" -> listOf("Easy swim", "Technique", "Threshold", "Intervals")
    "strength" -> listOf("Upper body", "Lower body", "Full body", "Push", "Pull")
    else -> emptyList()
}

fun workoutChoiceRequest(sport: String, focus: String, notes: String = ""): String = listOf(
    if (sport == "auto") "" else "Make this a ${workoutSports.getValue(sport).lowercase(java.util.Locale.ROOT)} workout" +
        (if (focus.isBlank()) "" else " focused on ${focus.lowercase(java.util.Locale.ROOT)}") + ".",
    notes.trim(),
).filter { it.isNotBlank() }.joinToString(" ")
