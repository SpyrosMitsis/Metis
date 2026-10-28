package com.workoutmaker.app.strength

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// ============================================================================
// F2 — import strength history from a Strong or Hevy CSV export. Pure parser
// (no Room/IO) so it's unit-testable; the repository turns the result into
// WorkoutEntity/SetEntity rows. Column layout is detected from the header, so
// both apps' formats (and kg/lb units) are handled.
// ============================================================================

object StrengthCsvImport {
    data class ParsedSet(val weightKg: Double, val reps: Int, val rpe: Int?, val isWarmup: Boolean, val note: String = "", val quantityUnit: String = "reps")
    data class ParsedExercise(val name: String, val sets: List<ParsedSet>)
    data class ParsedWorkout(val name: String, val startedAt: Long, val exercises: List<ParsedExercise>)
    data class ImportResult(
        val workouts: List<ParsedWorkout>,
        val format: String,
        // Rows intentionally skipped because they're cardio (distance/time, no reps).
        val cardioRows: Int = 0,
        // Rows we couldn't make sense of (missing exercise/reps and not cardio).
        val skippedRows: Int = 0,
    ) {
        val workoutCount get() = workouts.size
        val setCount get() = workouts.sumOf { w -> w.exercises.sumOf { it.sets.size } }
    }

    private const val LB_TO_KG = 0.45359237

    // Header aliases (lowercased) → canonical field.
    private val DATE = setOf("date", "start_time", "start time")
    private val TITLE = setOf("workout name", "title", "workout_name")
    private val EXERCISE = setOf("exercise name", "exercise_title", "exercise", "exercise_name")
    private val WEIGHT = setOf("weight", "weight_kg", "weight (kg)", "weight (lbs)", "weight_lbs", "weight (lb)")
    private val REPS = setOf("reps", "rep count")
    private val RPE = setOf("rpe")
    private val SET_TYPE = setOf("set_type", "set type")
    private val SET_ORDER = setOf("set order", "set_order", "set_index")
    private val UNIT = setOf("weight unit", "weight_unit", "unit")
    private val DISTANCE = setOf("distance", "distance_km", "distance (km)")
    private val SECONDS = setOf("seconds", "duration_seconds", "time", "duration")
    private val NOTES = setOf("notes", "note")

    fun parse(text: String): ImportResult {
        val lines = text.split('\n').map { it.trimEnd('\r') }.filter { it.isNotBlank() }
        if (lines.isEmpty()) return ImportResult(emptyList(), "empty")
        val delim = detectDelimiter(lines.first())
        val header = splitCsv(lines.first(), delim).map { it.trim().lowercase() }
        fun idx(aliases: Set<String>) = header.indexOfFirst { it in aliases }

        val iDate = idx(DATE); val iTitle = idx(TITLE); val iEx = idx(EXERCISE)
        val iW = idx(WEIGHT); val iR = idx(REPS); val iRpe = idx(RPE)
        val iType = idx(SET_TYPE); val iOrder = idx(SET_ORDER)
        val iUnit = idx(UNIT); val iDist = idx(DISTANCE); val iSec = idx(SECONDS); val iNote = idx(NOTES)
        if (iEx < 0 || iR < 0) return ImportResult(emptyList(), "unrecognized")

        val weightInLb = iW >= 0 && header[iW].contains("lb")
        val format = when {
            header.any { it == "exercise_title" } -> "Hevy"
            header.any { it == "exercise name" } -> "Strong"
            else -> "CSV"
        }

        // Preserve order: workouts keyed by the full start timestamp (so two
        // sessions with the same name on the same day stay separate), exercises
        // keyed by name.
        val workouts = LinkedHashMap<String, MutableMap<String, MutableList<ParsedSet>>>()
        val meta = LinkedHashMap<String, Pair<String, Long>>() // key -> (title, startedAt)
        var cardioRows = 0
        var skippedRows = 0

        for (line in lines.drop(1)) {
            val cols = splitCsv(line, delim)
            fun col(i: Int) = if (i in cols.indices) cols[i].trim() else ""
            val exName = col(iEx)
            val reps = col(iR).toDoubleOrNull()?.toInt() ?: -1
            if (exName.isBlank() || reps <= 0) {
                // No reps → either a cardio/timed entry (has distance or seconds)
                // or a genuinely unusable row. Count them separately so we can
                // tell the user exactly what was left out.
                val isCardio = (iDist >= 0 && col(iDist).toDoubleOrNull()?.let { it > 0 } == true) ||
                    (iSec >= 0 && col(iSec).toDoubleOrNull()?.let { it > 0 } == true)
                if (exName.isNotBlank() && isCardio) cardioRows++ else skippedRows++
                continue
            }
            var weight = col(iW).replace(",", ".").toDoubleOrNull() ?: 0.0
            // Prefer the per-row unit column (Strong/Hevy carry it) over a header guess.
            val rowLb = if (iUnit >= 0) col(iUnit).lowercase().startsWith("lb") else weightInLb
            if (rowLb) weight *= LB_TO_KG
            val rpe = col(iRpe).toDoubleOrNull()?.toInt()
            val typeStr = (col(iType) + " " + col(iOrder)).lowercase()
            val isWarmup = typeStr.contains("warm")

            val dateRaw = col(iDate)
            val title = col(iTitle).ifBlank { "Imported Workout" }
            val key = "$title|$dateRaw"
            meta.getOrPut(key) { title to parseMillis(dateRaw) }
            val note = if (iNote >= 0) col(iNote).take(200) else ""
            workouts.getOrPut(key) { LinkedHashMap() }
                .getOrPut(exName) { mutableListOf() }
                .add(ParsedSet(round2(weight), reps, rpe, isWarmup, note, if (header.indexOf("quantity unit") >= 0) cols.getOrNull(header.indexOf("quantity unit"))?.takeIf { it in setOf("reps", "seconds", "metres", "minutes") } ?: "reps" else "reps"))
        }

        val parsed = workouts.map { (key, exMap) ->
            val (title, started) = meta[key]!!
            ParsedWorkout(title, started, exMap.map { (n, sets) -> ParsedExercise(n, sets) })
        }
        return ImportResult(parsed, format, cardioRows, skippedRows)
    }

    private fun detectDelimiter(headerLine: String): Char {
        val c = headerLine.count { it == ',' }
        val s = headerLine.count { it == ';' }
        val t = headerLine.count { it == '\t' }
        return when (maxOf(c, s, t)) { s -> ';'; t -> '\t'; else -> ',' }
    }

    /** CSV field splitter honoring double-quoted fields with embedded delimiters. */
    private fun splitCsv(line: String, delim: Char): List<String> {
        val out = mutableListOf<String>()
        val sb = StringBuilder()
        var inQuotes = false
        var i = 0
        while (i < line.length) {
            val ch = line[i]
            when {
                ch == '"' && inQuotes && i + 1 < line.length && line[i + 1] == '"' -> { sb.append('"'); i++ }
                ch == '"' -> inQuotes = !inQuotes
                ch == delim && !inQuotes -> { out.add(sb.toString()); sb.setLength(0) }
                else -> sb.append(ch)
            }
            i++
        }
        out.add(sb.toString())
        return out
    }

    private val FORMATS = listOf(
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"),
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss"),
        DateTimeFormatter.ofPattern("dd MMM yyyy, HH:mm"),
    )

    private fun parseMillis(raw: String): Long {
        if (raw.isBlank()) return System.currentTimeMillis()
        val zone = ZoneId.systemDefault()
        for (f in FORMATS) {
            runCatching { return LocalDateTime.parse(raw.trim(), f).atZone(zone).toInstant().toEpochMilli() }
        }
        runCatching { return LocalDate.parse(raw.take(10)).atStartOfDay(zone).toInstant().toEpochMilli() }
        return System.currentTimeMillis()
    }

    private fun round2(v: Double): Double = Math.round(v * 100.0) / 100.0
}
