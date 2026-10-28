package com.workoutmaker.app.work

// Pure content decisions for the evening notification, kept out of the worker
// so JVM tests can cover them (the worker itself needs WorkManager + Android).
object FeedbackNotificationContent {

    // Same sport-matching the server uses when pairing a planned session with a
    // synced activity (see activityMatchesPlanned in _shared/analyze_core.ts).
    fun typeLooksLike(plannedType: String, actualType: String?): Boolean =
        com.workoutmaker.app.data.activityMatchesPlan(plannedType, actualType)

    // Title + text. With an analysis (label/feedback) the notification leads
    // with the coach's verdict; otherwise the plain "how did it feel?" ask.
    // feedbackPending = the athlete hasn't logged their subjective rating yet.
    fun build(
        greeting: String,
        workoutTitle: String,
        label: String?,
        feedback: String?,
        feedbackPending: Boolean,
    ): Pair<String, String> {
        val verdict = label?.trim()?.takeIf { it.isNotEmpty() }
        val note = feedback?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }
        if (verdict == null && note == null) {
            return "$greeting. How did it feel?" to
                "Rate \"$workoutTitle\", your coach uses it to tune the next sessions."
        }
        val title = "Coach debrief: ${verdict ?: "session analyzed"}"
        val snippet = note?.let { if (it.length > 120) it.take(119) + "…" else it }
        val tail = if (feedbackPending) {
            "Tap for the full breakdown and tell your coach how it felt."
        } else {
            "Tap for the full breakdown."
        }
        val text = listOfNotNull(snippet, tail).joinToString(" ")
        return title to text
    }
}
