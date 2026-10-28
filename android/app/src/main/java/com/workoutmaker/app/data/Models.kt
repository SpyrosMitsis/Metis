package com.workoutmaker.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Kotlin mirror of /shared/types.ts. Keep field names in sync with the schema.

enum class LlmProvider(val label: String, val model: String, val freeKeyUrl: String, val freeTier: Boolean) {
    @SerialName("anthropic") ANTHROPIC("Anthropic", "claude-opus-4-8", "https://console.anthropic.com/settings/keys", false),
    @SerialName("deepseek")  DEEPSEEK("DeepSeek", "deepseek-v4-flash", "https://platform.deepseek.com/api_keys", false),
    @SerialName("openai")    OPENAI("OpenAI", "gpt-5-mini", "https://platform.openai.com/api-keys", false),
    @SerialName("gemini")    GEMINI("Google Gemini", "gemini-2.5-flash", "https://aistudio.google.com/app/apikey", true),
    @SerialName("groq")      GROQ("Groq", "llama-3.3-70b-versatile", "https://console.groq.com/keys", true),
    // OpenRouter — one key, hundreds of models behind a fixed OpenAI-compatible
    // endpoint. Default model auto-routes; pick any model id in Settings.
    @SerialName("openrouter") OPENROUTER("OpenRouter", "openrouter/auto", "https://openrouter.ai/keys", false),
    // Bring-your-own OpenAI-compatible endpoint (Ollama / LM Studio / vLLM …).
    // No fixed model or free-key link — the user supplies a base URL, model id,
    // and key in Settings.
    @SerialName("custom")    CUSTOM("Custom (OpenAI-compatible)", "", "", false);

    val key: String get() = name.lowercase()
}

@Serializable
data class WorkoutExercise(
    val name: String,
    val sets: Int = 0,
    val reps: String = "",
    val weight_kg: Double? = null,
    val pace_zone: String? = null,
    val hr_zone: String? = null,
    val rest_seconds: Int? = null,
    val notes: String = "",
    // Catalog metadata, present only on AI-introduced exercises that aren't in
    // the bundled library (used to auto-register them as custom exercises).
    val muscle: String? = null,
    val category: String? = null,
    val compound: Boolean? = null,
    val dose: kotlinx.serialization.json.JsonObject? = null,
)

@Serializable
data class WorkoutSection(
    val name: String,
    val duration_minutes: Double = 0.0,
    val exercises: List<WorkoutExercise> = emptyList(),
)

@Serializable
data class Workout(
    val type: String,
    val title: String,
    val duration_minutes: Double = 0.0,
    val tss_estimate: Double = 0.0,
    val rpe_target: Double = 0.0,
    val sections: List<WorkoutSection> = emptyList(),
    val coach_note: String = "",
    val prescription: kotlinx.serialization.json.JsonObject? = null,
)

@Serializable
data class PlannedWorkout(
    val id: String,
    val date: String,
    val type: String,
    val workout_json: Workout,
    val llm_provider: String? = null,
    val llm_model: String? = null,
    val intervals_event_id: String? = null,
    val completed: Boolean = false,
    val locked: Boolean = false,
    val skipped: Boolean = false,
    val created_at: String? = null,
    val reconciliation_status: String = "unknown",
    val activity_ids: List<String> = emptyList(),
    val session_slot: Int = 0,
    val start_minute: Int? = null,
    val combined_group: String? = null,
)

@Serializable
data class ReadinessComponents(val wellness: Double, val hrvDelta: Double, val rhrDelta: Double)

@Serializable
data class Readiness(val score: Int, val band: String, val components: ReadinessComponents)

// Deeper recovery breakdown (HRV/RHR/sleep trends behind the readiness score).
// `latest`/`hours` are null when today's reading hasn't synced from Intervals —
// the UI shows that explicitly instead of falling back to yesterday's value.
@Serializable
data class RecoveryTrend(
    val latest: Double? = null,
    val baseline: Double,
    val deltaPct: Double,
    // Recent values (oldest→newest) for the inline sparkline next to the trend badge.
    val series: List<Double> = emptyList(),
)

@Serializable
data class RecoverySleep(val hours: Double? = null, val avgHours: Double? = null, val score: Double? = null)

// One reason behind the readiness score, rendered as a chip. dir = up|down|flat,
// tone = good|bad|neutral (drives the chip colour).
@Serializable
data class RecoveryDriver(val label: String, val dir: String, val tone: String)

@Serializable
data class Recovery(
    val score: Int,
    val band: String,
    // What the score rests on: "measured" (something synced), "subjective" (a
    // check-in only) or "none". With nothing at all the server still computes
    // 50/amber from its neutral defaults, so the UI must not draw that as a
    // reading. Defaults to "measured" so an older server (no field) renders
    // exactly as it does today.
    val basis: String = "measured",
    val wellness: Double = 3.0,
    val hrv: RecoveryTrend? = null,
    val rhr: RecoveryTrend? = null,
    val sleep: RecoverySleep? = null,
    val drivers: List<RecoveryDriver> = emptyList(),
    val summary: String = "",
)

@Serializable
data class WeeklyLoad(val tss: Int, val target: Int)

@Serializable
data class SportTss(val sport: String, val tss: Int)

@Serializable
data class WeekAdherence(val done: Int, val planned: Int, val pct: Int? = null)

@Serializable
data class WeekLoad(val tss: Int, val target: Int, val prev_tss: Int, val delta_pct: Int? = null)

@Serializable
data class WeekStandout(val date: String, val sport: String, val tss: Int)

// Deterministic last-7-day recap shown on Home (computed server-side in
// daily-summary; the coach-voice line comes separately from coach-brief).
@Serializable
data class WeekReview(
    val adherence: WeekAdherence,
    val load: WeekLoad,
    val by_sport: List<SportTss> = emptyList(),
    val sessions: Int = 0,
    val standout: WeekStandout? = null,
)

// The coach's proactive daily note (coach-brief edge function).
@Serializable
data class CoachBriefResponse(
    val brief: String? = null,
    val date: String? = null,
    val provider: String? = null,
    val disabled: Boolean = false,
)

@Serializable
data class CoachWeekReviewResponse(
    val review: String? = null,
    val week_start: String? = null,
    val provider: String? = null,
)

@Serializable
data class GoalProgress(
    val goal: String,
    val goal_date: String? = null,
    val weeks_to_goal: Int? = null,
    val phase: String = "",
    val ctl_trend: Double = 0.0,
    val on_track: String = "",
)

@Serializable
data class Vo2Max(val value: Double, val change: Double? = null)

// What this deployment can do. A self-hosted backend without the hosted LLM
// secrets reports hosted_ai=false and the app never shows Pro UI.
@Serializable
data class ServerCapabilities(val hosted_ai: Boolean = false)

// Today's (or yesterday's) analyzed session, picked server-side for the Home
// "Session debrief" card. activity_id is null for strength sessions (their
// analyses key on date, not on a completed_activities row).
@Serializable
data class SessionDebrief(
    val kind: String = "activity",
    val activity_id: String? = null,
    val date: String = "",
    val type: String? = null,
    val score: Int? = null,
    val label: String? = null,
    val feedback: String? = null,
)

@Serializable
data class ReadinessContext(val status:String="unknown",val score:Int?=null,val basis:String="none",val observations:List<String> = emptyList(),val conflicts:List<String> = emptyList(),val next_action:String="",val limits:String="")

@Serializable
data class DailySummary(
    val date: String,
    val readiness: Readiness,
    val recovery: Recovery? = null,
    // Most recent date (≤ this summary's date) with any objective recovery signal
    // synced; null = none in the window. Drives the "last synced" freshness line.
    val recovery_synced_date: String? = null,
    val vo2max: Vo2Max? = null,
    val today_workout: PlannedWorkout? = null,
    val weekly_load: WeeklyLoad,
    val week_review: WeekReview? = null,
    val debrief: SessionDebrief? = null,
    val body_trend: BodyTrend? = null,
    val active_llm_provider: String,
    val goal: GoalProgress? = null,
    val server: ServerCapabilities? = null,
    // The injury follow-up loop (server-computed, see _shared/injury.ts). All
    // three are read-only payload: nothing is written until the athlete answers,
    // so re-fetching the summary never changes what is asked.
    val injury_checkin: InjuryCheckin? = null,
    val pain_check: PainCheck? = null,
    val injury_backoff: List<InjuryBackoff> = emptyList(),
    val readiness_context: ReadinessContext? = null,
)

// "Is your knee still bothering you?", surfaced a few days after the athlete
// raised it and then weekly while it persists. `question` is composed
// server-side so the wording is identical wherever it gets asked.
@Serializable
data class InjuryCheckin(
    val area: String,
    val severity: String? = null,
    val note: String? = null,
    val raised_at: String? = null,
    val days_since: Int? = null,
    val question: String,
)

// Which injury today's session could have aggravated. Present only when the
// session actually loads that area, so the question is never noise.
@Serializable
data class PainCheck(
    val area: String,
    val planned_workout_id: String? = null,
)

// What injury-checkin decided a pain answer meant. `severe` is the server
// saying this is past the app's pay grade, not a diagnosis.
@Serializable
data class PainReportResult(
    val ok: Boolean = false,
    val area: String = "",
    val pain: Int = 0,
    val backoff: InjuryBackoff? = null,
    val cleared: Boolean = false,
    val severe: Boolean = false,
)

// A dated instruction the generator is already enforcing. Shown so the athlete
// knows why their training changed shape.
@Serializable
data class InjuryBackoff(
    val area: String,
    val level: String,   // "ease" | "avoid"
    val until: String,
    val reason: String? = null,
)

// --- Body composition (weight / body fat / lean mass over time) --------------
