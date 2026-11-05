package com.workoutmaker.app.util

/** Redact before truncation or writing to either log destination. */
fun redactLog(text: String): String = text
    .replace(Regex("""(?i)Bearer\s+[^\s,\]}]+"""), "Bearer [REDACTED]")
    .replace(Regex("""(?i)(authorization|apikey|api[_-]?key|access_token|refresh_token|password)(["']?\s*[:=]\s*)(\[[^\]]*\]|"[^"]*"|'[^']*'|[^\s,;}]+)"""), "$1$2[REDACTED]")
    .replace(Regex("""eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"""), "[REDACTED JWT]")
