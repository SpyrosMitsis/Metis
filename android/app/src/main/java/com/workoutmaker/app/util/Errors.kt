package com.workoutmaker.app.util

// ============================================================================
// Every "turn a failure into something a person can read" helper in the app.
//
// There are THREE, because they face three different failure sources and each
// produces different text. They used to live in three different packages, so
// call sites picked whichever they happened to find — ActivityDetailScreen
// imported two of them. They are gathered here to make the choice explicit.
// They are deliberately NOT merged: their outputs differ, so folding them
// together would change what the user sees.
//
//   friendlyFnError(t)    edge functions. Prefers the server's own JSON
//                         {"error": "..."} text, which is already written for
//                         a person (quota messages, "no key configured"),
//                         and otherwise maps transport noise to a hint.
//                         Takes a per-call-site [fallback].
//   friendlyAuthError(t)  Supabase GoTrue. Matches the terse auth strings
//                         ("Invalid login credentials") that no other source
//                         emits. Falls through to the raw message.
//   friendlyError(any)    generic/UI. Accepts Any? (a String banner OR a
//                         Throwable) and collapses anything long or unknown
//                         to a flat retry line.
//
// Callers still log the raw throwable via AppLog — this is only what the user
// reads.
// ============================================================================

private val JSON_ERROR = Regex("\"(?:error|detail|message)\"\\s*:\\s*\"([^\"]+)\"")

/** The server's own error text, when the failure carried a JSON body. */
fun serverErrorText(t: Throwable): String? =
    t.message?.let { JSON_ERROR.find(it)?.groupValues?.get(1) }

/**
 * A message safe to put in front of a user for any edge-function failure.
 * [fallback] is used when the cause isn't one we recognise, so each call site
 * can say what it was trying to do.
 */
fun friendlyFnError(t: Throwable, fallback: String = "Something went wrong. Try again."): String {
    serverErrorText(t)?.let { return it }
    val m = t.message ?: return fallback
    return when {
        m.contains("Week planning is already running") -> "Week planning is already running. Check the calendar for progress."
        m.contains("Unauthorized", true) || m.contains("JWT expired", true) -> "Your session expired. Sign in again, then retry."
        m.contains("timeout", true) || m.contains("timed out", true) ->
            "That took too long to come back. Try again."
        m.contains("Unable to resolve host", true) || m.contains("Failed to connect", true) ||
            m.contains("No address associated", true) || m.contains("Network is unreachable", true) ->
            "Can't reach the server. Check your internet connection."
        else -> fallback
    }
}

// Supabase auth errors are terse and technical. Translate the common ones.
internal fun friendlyAuthError(t: Throwable): String {
    val m = t.message ?: return "Something went wrong. Please try again."
    return when {
        m.contains("Invalid login credentials", true) -> "Wrong email or password."
        m.contains("Email not confirmed", true) ->
            "Your email isn't confirmed yet. Check your inbox for the confirmation link."
        m.contains("already registered", true) ->
            "An account with this email already exists. Sign in instead."
        m.contains("Password should be", true) -> "Password is too short. Use at least 6 characters."
        m.contains("rate limit", true) || m.contains("too many", true) ->
            "Too many attempts. Wait a minute and try again."
        m.contains("is invalid", true) || m.contains("validate email", true) ->
            "That doesn't look like a valid email address."
        m.contains("Unable to resolve host", true) || m.contains("Failed to connect", true) ||
            m.contains("timeout", true) || m.contains("No address associated", true) ->
            "Can't reach the server. Check your internet connection."
        else -> m
    }
}

/**
 * Turn a raw error (exception or message) into something a person can act on.
 * Network/timeout failures become a friendly connection hint; long technical
 * stack-y strings collapse to a generic retry message.
 */
fun friendlyError(error: Any?): String {
    val msg = when (error) {
        is Throwable -> error.message ?: error.toString()
        null -> ""
        else -> error.toString()
    }
    val reference = Regex("Support reference: ([a-fA-F0-9-]{36})").find(msg)?.groupValues?.get(1)
    if (reference != null) return friendlyError(msg.substringBefore("Support reference:").trimEnd()) + "\nSupport reference: $reference"
    val low = msg.lowercase()
    return when {
        low.isBlank() -> "Something went wrong. Please try again."
        listOf(
            "unable to resolve host", "failed to connect", "network", "timeout",
            "timed out", "unreachable", "no address associated", "connection",
        ).any { it in low } -> "Can't reach the server, check your connection."
        "unauthor" in low || "401" in low -> "Your session expired, please sign in again."
        msg.length > 140 -> "Something went wrong. Please try again."
        else -> msg
    }
}

/** One support reference links the visible failure to a redacted local log. */
fun reportFailure(t: Throwable, fallback: String = "Couldn’t complete that action. Please try again.", reference: String = java.util.UUID.randomUUID().toString()): String {
    AppLog.e("support", "reference=$reference", t)
    return "${friendlyFnError(t, fallback)}\nSupport reference: $reference"
}
