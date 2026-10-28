package com.workoutmaker.app.data

import kotlinx.serialization.Serializable
import java.time.LocalDate

// Kotlin mirror of /shared/types.ts. Keep field names in sync with the schema.
//
// Talking to the coach and configuring it: chat turns and conversations, the
// LLM key/model surfaces, and the wellness check-ins that feed readiness.

// A saved LLM API key row (the key itself never leaves the server — only a
// masked hint like "sk-an••••3kQx" for the settings UI).
@Serializable
data class LlmKeyRow(
    val provider: String,
    val is_valid: Boolean? = null,
    val last_tested_at: String? = null,
    val key_hint: String? = null,
    // Only set for the custom provider (its OpenAI-compatible endpoint).
    val base_url: String? = null,
)

@Serializable
data class WorkoutFeedback(
    val id: String = java.util.UUID.randomUUID().toString(),
    val planned_workout_id: String? = null,
    val date: String,
    val completed: Boolean = true,
    val actual_rpe: Int? = null,
    val difficulty: String? = null,   // too_easy | just_right | too_hard
    val notes: String? = null,
    val activity_id: String? = null,
    val reason: String? = null,
    val outcome: String? = null,
    val actual_minutes: Double? = null,
    val pain_area: String? = null,
    val soreness_area: String? = null,
    val enjoyment: Int? = null,
    val usefulness: Int? = null,
    val unwanted_change: Boolean? = null,
)

@Serializable
data class GenerationLogRow(
    val created_at: String? = null,
    val feature: String? = null,
    val provider: String? = null,
    val model: String? = null,
    // Nullable ON PURPOSE: the server writes SQL null for tokens/cost when a
    // generation failed ("claim no cost, not $0"). kotlinx defaults only cover
    // ABSENT keys, so non-nullable fields here made one failure row poison the
    // whole decodeList and Diagnostics showed "No AI generations yet" forever.
    val prompt_tokens: Int? = null,
    val completion_tokens: Int? = null,
    val parsed_ok: Boolean = false,
    val error: String? = null,
    val estimated_cost_usd: Double? = null,
)

// Dynamic model selector — model ids fetched live from the provider's API.
@Serializable
data class ModelListResponse(
    val provider: String = "",
    val default_model: String? = null,
    val current: String? = null,
    val models: List<String> = emptyList(),
    val error: String? = null,
)

@Serializable
data class TestKeyRequest(
    val provider: String,
    val apiKey: String,
    val sampleGeneration: Boolean = false,
    // Custom provider only: OpenAI-compatible base URL + model id.
    val baseUrl: String? = null,
    val model: String? = null,
)

@Serializable
data class TestKeyResponse(
    val provider: String,
    val model: String,
    val is_valid: Boolean,
    val error: String? = null,
    val sample: String? = null,
    val estimated_cost_usd: Double = 0.0,
)

@Serializable
data class WellnessCheckin(
    val date: String,
    val energy: Int? = null,
    val soreness: Int? = null,
    // No sleep field: sleep is sourced objectively from the Intervals.icu sleep
    // score (wellness_checkins.sleep_score, mirrored by sync-intervals). The old
    // manual sleep_quality rating has been fully removed.
)

// A day's recovery signals for the trends screen (subset of wellness_checkins).
@Serializable
data class RecoveryHistoryPoint(
    val date: String,
    val hrv_rmssd: Double? = null,
    val resting_hr: Int? = null,
    val sleep_score: Int? = null,
    val zepp_sleep_minutes: Int? = null,
)

// Health Connect metrics upserted onto the day's wellness row.
@Serializable
data class WellnessHealthUpdate(
    val date: String,
    val hrv_rmssd: Double? = null,
    val resting_hr: Int? = null,
    val zepp_sleep_minutes: Int? = null,
    val steps: Int? = null,
    val sleep_deep_min: Int? = null,
    val sleep_rem_min: Int? = null,
    val vo2max: Double? = null,
    val source: String = "health_connect",
)

// --- Coach chat -------------------------------------------------------------
@Serializable
data class ChatMessage(val role: String, val content: String)

@Serializable
data class CoachChatRequest(
    val messages: List<ChatMessage>,
    val mode: String = "chat",                 // "chat" | "finalize"
    val finalizeKind: String? = null,          // "workout" | "plan"
    val conversationId: String? = null,
    val purpose: String = "plan",
    val save: Boolean = false,
    val stream: Boolean = false,
    // Streaming protocol this client understands.
    //   1 = one {token} event carrying the whole reply (the original shape).
    //   2 = live token deltas, plus {reset} when the coach discards a narrated
    //       preamble and starts over.
    // A v1 client would silently ignore {reset} and leave the discarded text on
    // screen forever, so the server only streams speculatively when it sees 2.
    val streamProtocol: Int = 2,
    // Incognito turn: the server answers with full context but persists nothing
    // (no conversation row, no knowledge/summary updates).
    val incognito: Boolean = false,
    // OUR local date. The edge function runs in UTC and the athlete does not,
    // so a server-computed "today" is the wrong day for part of every 24 hours:
    // the coach would plan around yesterday, and its write tools would refuse a
    // session for today as being in the past. Same rule the rest of the app
    // follows (see CLAUDE.md); the server falls back to UTC without it.
    val today: String = LocalDate.now().toString(),
)

// A device setting the coach changed via the update_app_settings tool. Values
// arrive normalized as strings ("dark", "90", "true"); the app maps them onto
// AppPreferences through its own whitelist (ChatSettings.kt).
@Serializable
data class ChatSettingChange(val key: String, val value: String)

@Serializable
data class CoachReply(
    val reply: String? = null,
    val conversation_id: String? = null,
    val provider: String? = null,
    val estimated_cost_usd: Double = 0.0,
    val tools_used: List<String> = emptyList(),
    val settings_changes: List<ChatSettingChange> = emptyList(),
)

@Serializable
data class CoachConversation(
    val id: String,
    val title: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val updated_at: String? = null,
    val pinned: Boolean = false,
)
