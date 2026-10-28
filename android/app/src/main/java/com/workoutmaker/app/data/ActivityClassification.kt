package com.workoutmaker.app.data

internal fun persistedActivityId(id: String): Boolean =
    Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}").matches(id)

internal fun activityStatusLabel(status: String): String = when (status) {
    "completed_as_planned" -> "Completed as planned"
    "modified" -> "Modified workout"
    "substituted" -> "Different workout"
    "unplanned" -> "Unplanned activity"
    else -> "Not assessed"
}

/** Source identity wins. Legacy digest matching must be unique; never use the
 * first same-day activity and risk editing a different workout. */
internal fun resolveActivity(activity: CompletedActivity, candidates: List<CompletedActivity>): CompletedActivity? {
    if (persistedActivityId(activity.id)) return candidates.singleOrNull { it.id == activity.id }
    if (activity.intervals_id != "digest") return candidates.singleOrNull { it.intervals_id == activity.intervals_id }
    return candidates.filter { it.date == activity.date && it.displayName.equals(activity.displayName, true) &&
        it.type.equals(activity.type, true) && (activity.duration_seconds == null || it.duration_seconds?.let { seconds -> kotlin.math.abs(seconds - activity.duration_seconds) <= 60 } == true)
    }.singleOrNull()
}

/** Never render exception messages here: PostgREST exceptions can contain
 * authorization headers, URLs and payloads. */
internal fun activityCorrectionError(error: Throwable): String {
    val message = error.message.orEmpty()
    return when {
        message.contains("activity changed", true) || message.contains("40001") -> "This activity changed elsewhere. Reopen the editor and try again."
        message.contains("plan required", true) -> "Choose a workout to use this classification."
        message.contains("plan not available", true) -> "That workout is no longer available. Choose another workout."
        message.contains("activity not found", true) -> "This activity is not available yet. Sync activities and try again."
        message.contains("timeout", true) || message.contains("Unable to resolve host", true) || message.contains("Failed to connect", true) -> "Could not connect. Check your connection and try again."
        else -> "Could not save the changes. Please try again."
    }
}
