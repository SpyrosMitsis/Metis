package com.workoutmaker.app.data

import com.workoutmaker.app.util.runCatching

import io.github.jan.supabase.functions.functions
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.rpc
import io.github.jan.supabase.postgrest.query.Order
import io.ktor.client.call.body
import io.ktor.client.request.setBody
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject

// --- Direct table access (RLS-scoped to the signed-in user) --------------
// Write-through cached so the Calendar still renders the plan offline.
suspend fun WorkoutRepository.plannedWorkouts(fromDate: String): List<PlannedWorkout> = withAccount {
    // Row-tolerant decode: one schema-drifted workout_json must drop that row,
    // not fail the whole Calendar/Coach plan fetch (the cached path below
    // already does the same per-row).
    val rows: List<PlannedWorkout> = supabase.postgrest.from("reconciled_plans").select {
        filter { gte("date", fromDate) }
        order("date", Order.DESCENDING)
    }.decodeList<JsonObject>().mapNotNull { el ->
        runCatching { json.decodeFromJsonElement(PlannedWorkout.serializer(), el) }
            .logFailure("plannedWorkouts/row").getOrNull()
    }
    runCatching {
        cache.replaceWorkoutsFrom(
            fromDate,
            rows.map {
                CachedWorkout(
                    id = it.id,
                    date = it.date,
                    type = it.type,
                    workoutJson = json.encodeToString(PlannedWorkout.serializer(), it),
                )
            },
        )
    }.logFailure("plannedWorkouts/cache")
    return@withAccount rows
}

// Last successfully-fetched plan (offline fallback for the Calendar).
suspend fun WorkoutRepository.cachedPlannedWorkouts(): List<PlannedWorkout> = runCatching {
    cache.workouts().mapNotNull { row ->
        runCatching {
            json.decodeFromString(PlannedWorkout.serializer(), row.workoutJson)
        }.getOrNull()
    }
}.logFailure("cachedPlannedWorkouts").getOrDefault(emptyList())

suspend fun WorkoutRepository.templates(): List<WorkoutTemplate> =
    supabase.postgrest.from("workout_templates").select {
        order("created_at", Order.DESCENDING)
    }.decodeList()

suspend fun WorkoutRepository.planWeek(req: PlanWeekRequest): PlanWeekResult = withAccount {
    // Opt-in: hand the planner the week's busy windows so it schedules
    // around life (long/hard sessions on free days). Times only, no titles.
    val enriched = req.copy(start_date = req.start_date ?: req.today, calendar_busy = req.calendar_busy ?: calendarBusy(req.start_date, days = 7))
    val result: PlanWeekResult = json.decodeFromString(
        supabase.functions.invoke("plan-week") {
            setBody(json.encodeToString(PlanWeekRequest.serializer(), enriched))
        }.body(),
    )
    syncPlanToDeviceCalendar()
    return@withAccount result
}

// P7: move a planned workout to another date — server-side, so the
// Intervals.icu/watch event moves with it.
suspend fun WorkoutRepository.reschedulePlanned(plannedId: String, newDate: String) = withAccount {
    supabase.functions.invoke("move-workout") {
        setBody(
            buildJsonObject {
                put("workout_id", JsonPrimitive(plannedId))
                put("new_date", JsonPrimitive(newDate))
            }.toString(),
        )
    }
    syncPlanToDeviceCalendar()
}

// Lock/unlock a planned session so the weekly re-planner leaves it fixed.
suspend fun WorkoutRepository.setLocked(plannedId: String, locked: Boolean) = withAccount {
    supabase.postgrest.from("planned_workouts")
        .update(mapOf("locked" to JsonPrimitive(locked))) { filter { eq("id", plannedId) } }
}

// "Don't ask again" from the weather-swap dialog — direct RLS-scoped update,
// no edge function/LLM involved. Read by weather-check/index.ts.
suspend fun WorkoutRepository.setWeatherPromptOptOut(optOut: Boolean) = withAccount {
    supabase.postgrest.from("user_profiles")
        .update(mapOf("weather_prompt_opt_out" to JsonPrimitive(optOut))) { filter { eq("id", uid()) } }
}

// Ask the AI for a session on a specific date from a free-text request
// (e.g. "social 10k run with friends, keep it easy"), locked by default so
// the weekly re-planner plans around it instead of replacing it.
suspend fun WorkoutRepository.requestSession(date: String, request: String, type: String, lock: Boolean = true): GenerateResult = withAccount {
    val result: GenerateResult = json.decodeFromString(
        supabase.functions.invoke("generate-workout") {
            setBody(json.encodeToString(GenerateRequest.serializer(),
                GenerateRequest(date = date, type = type, request = request, lock = lock, push = true)))
        }.body(),
    )
    syncPlanToDeviceCalendar()
    return@withAccount result
}

// E5: persist a manually-built structured workout into the plan (client-side),
// returning its id so it can optionally be pushed to Intervals.icu.
suspend fun WorkoutRepository.savePlannedWorkout(date: String, workout: Workout): String = withAccount {
    val id = UUID.randomUUID().toString()
    val row = buildJsonObject {
        put("id", JsonPrimitive(id))
        put("user_id", JsonPrimitive(uid()))
        put("date", JsonPrimitive(date))
        put("type", JsonPrimitive(workout.type))
        put("workout_json", json.encodeToJsonElement(Workout.serializer(), workout))
    }
    supabase.postgrest.from("planned_workouts").insert(row)
    return@withAccount id
}

suspend fun WorkoutRepository.weekPlan(start: String): WeekPlanRow? =
    runCatching {
        supabase.postgrest.from("week_plans").select {
            filter { eq("start_date", start) }
        }.decodeList<WeekPlanRow>().firstOrNull()
    }.logFailure("weekPlan").getOrNull()

suspend fun WorkoutRepository.setAutoPlan(enabled: Boolean) = withAccount {
    supabase.postgrest.from("user_profiles").update(mapOf("auto_plan" to enabled)) {
        filter { eq("id", uid()) }
    }
    invalidateProfileCache()
}

suspend fun WorkoutRepository.autoPlanEnabled(): Boolean = runCatching {
    (profileRow()?.get("auto_plan") as? JsonPrimitive)?.content?.toBoolean() ?: false
}.logFailure("autoPlanEnabled").getOrDefault(false)

suspend fun WorkoutRepository.scheduleTemplate(req: ScheduleRequest): ScheduleResult =
    json.decodeFromString(
        supabase.functions.invoke("schedule-template") {
            setBody(json.encodeToString(ScheduleRequest.serializer(), req))
        }.body(),
    )

suspend fun WorkoutRepository.submitFeedback(fb: WorkoutFeedback) = withAccount {
    supabase.postgrest.rpc("save_workout_feedback", buildJsonObject {
        put("p_owner", uid())
        put("p_feedback", json.encodeToJsonElement(WorkoutFeedback.serializer(), fb))
    })
}

// Completion and feedback commit together; the same ID survives uncertain retries.
suspend fun WorkoutRepository.markPlannedComplete(
    plannedId: String, date: String, completed: Boolean, difficulty: String?, rpe: Int?,
    feedbackId: String = UUID.randomUUID().toString(), notes: String? = null,
) = withAccount {
    submitFeedback(WorkoutFeedback(id = feedbackId, planned_workout_id = plannedId, date = date,
        completed = completed, actual_rpe = rpe, difficulty = difficulty, notes = notes))
    if (!completed) syncPlanToDeviceCalendar()
}

// Undo a skip: restore the session and drop the skip feedback so the
// planner doesn't count it against adherence.
suspend fun WorkoutRepository.undoSkip(plannedId: String) = withAccount {
    supabase.postgrest.from("planned_workouts")
        .update(mapOf("skipped" to JsonPrimitive(false))) { filter { eq("id", plannedId) } }
    runCatching {
        supabase.postgrest.from("workout_feedback").delete {
            filter { eq("planned_workout_id", plannedId); eq("completed", false) }
        }
    }.logFailure("undoSkip/feedback")
}

// Past activities pulled from Intervals.icu (or logged manually).
suspend fun WorkoutRepository.completedActivities(fromDate: String): List<CompletedActivity> =
    supabase.postgrest.from("effective_activities").select {
        filter { gte("date", fromDate) }
        order("date", Order.DESCENDING)
    }.decodeList()

// Adaptive re-planning: reconcile this week's plan against what was actually
// done (per Intervals.icu), then re-plan from today factoring real load.
// plan-week already feeds actual load + adherence into the LLM prompt, so
// re-planning here intelligently accounts for over/under-training and swaps.
suspend fun WorkoutRepository.adaptWeek(weekStart: String, today: String): AdaptResult = withAccount {
    val planned = runCatching { plannedWorkouts(weekStart) }.logFailure("adaptWeek/planned").getOrDefault(emptyList())
        .filter { it.date in weekStart..today }
    // Persistent inference is evidence, never athlete-confirmed completion.
    supabase.postgrest.rpc("reconcile_sessions", buildJsonObject { put("p_owner", uid()) })
    val reconciled = planned.count { it.activity_ids.isNotEmpty() }
    val missed = planned.count { it.skipped }
    // Re-plan today → +6: deletes non-completed/non-locked in range and
    // regenerates around what actually happened and your current fitness.
    val attempt = runCatching { planWeek(PlanWeekRequest(start_date = today)) }.logFailure("adaptWeek/planWeek")
    val r = attempt.getOrNull()
    if (r == null || r.error != null) {
        // Surface the function's real error (it travels in the exception body)
        // instead of a blind "re-plan failed".
        val why = r?.error
            ?: attempt.exceptionOrNull()?.let { fnErrorMessage(it) }
            ?: "re-plan failed"
        return@withAccount AdaptResult(reconciled, missed, false,
            "Reconciled $reconciled · $missed missed", why)
    }
    val parts = buildList {
        if (reconciled > 0) add("✓ matched $reconciled to your actual sessions")
        if (missed > 0) add("$missed planned session(s) you skipped")
        add("re-planned the rest of your week around what you did")
    }
    return@withAccount AdaptResult(reconciled, missed, true, parts.joinToString(" · "))
}

// Log a session done off-watch so it feeds load/ACWR/adherence.
suspend fun WorkoutRepository.logManualActivity(date: String, type: String, durationMin: Int, distanceKm: Double?, rpe: Int?) = withAccount {
    val tss = durationMin * (rpe ?: 5) / 6.0
    supabase.postgrest.from("completed_activities").insert(
        ManualActivityInsert(
            intervals_id = "manual:" + UUID.randomUUID(),
            type = type,
            date = date,
            duration_seconds = durationMin * 60,
            distance_m = distanceKm?.let { it * 1000 },
            tss = tss,
        ),
    )
}

// "Adjust this workout" — revise an existing workout via the generator.
suspend fun WorkoutRepository.adjustWorkout(base: Workout, instruction: String, date: String?): GenerateResult =
    json.decodeFromString(
        supabase.functions.invoke("generate-workout") {
            setBody(
                json.encodeToString(
                    GenerateRequest.serializer(),
                    GenerateRequest(date = date, adjustment = instruction, base_workout = base, push = true),
                ),
            )
        }.body(),
    )
