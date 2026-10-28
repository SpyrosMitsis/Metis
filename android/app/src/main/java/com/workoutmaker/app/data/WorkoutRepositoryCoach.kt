package com.workoutmaker.app.data

import com.workoutmaker.app.util.runCatching

import io.github.jan.supabase.gotrue.auth
import io.github.jan.supabase.functions.functions
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Order
import io.ktor.client.call.body
import io.ktor.client.request.header
import io.ktor.client.request.preparePost
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import com.workoutmaker.app.util.AppLog
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray

// --- Strength logs -------------------------------------------------------
suspend fun WorkoutRepository.logStrengthSet(log: StrengthLogInsert) = withAccount {
    supabase.postgrest.from("strength_logs").insert(log)
}

// Fire-and-forget refresh of the rolling athlete "training memory".
// Invalidates the profile cache so a following loadMemory() reads the new notes.
suspend fun WorkoutRepository.refreshMemory() = withAccount {
    runCatching { supabase.functions.invoke("refresh-memory") }.logFailure("refreshMemory")
    invalidateProfileCache()
}

// Wide window so the diagnostics screen can total real 30-day spend; the UI
// aggregates client-side. 500 recent rows is ample for one user.
suspend fun WorkoutRepository.generationLogs(limit: Long = 500): List<GenerationLogRow> =
    supabase.postgrest.from("generation_logs").select(
        // Explicit columns: the table also stores full prompts + raw model
        // output — hundreds of KB the diagnostics screen never shows.
        io.github.jan.supabase.postgrest.query.Columns.list(
            "created_at", "feature", "provider", "model", "prompt_tokens",
            "completion_tokens", "parsed_ok", "error", "estimated_cost_usd",
        ),
    ) {
        order("created_at", Order.DESCENDING)
        limit(limit)
    }.decodeList()

// --- Coach chat ----------------------------------------------------------
suspend fun WorkoutRepository.coachChat(req: CoachChatRequest): CoachReply =
    AppLog.time("coach", "coach-chat mode=${req.mode} turns=${req.messages.size}") {
        json.decodeFromString<CoachReply>(
            supabase.functions.invoke("coach-chat") {
                setBody(json.encodeToString(CoachChatRequest.serializer(), req))
            }.body(),
        ).also {
            // The coach may have evolved memory/soul server-side this turn.
            invalidateProfileCache()
        }
    }

// Past coach conversations for the history list. Ordered by recency here;
// the UI sorts pinned-first client-side so this query keeps working even
// before the `pinned` column migration is pushed.
suspend fun WorkoutRepository.coachConversations(): List<CoachConversation> =
    supabase.postgrest.from("coach_conversations").select {
        order("updated_at", Order.DESCENDING)
        limit(100)
    }.decodeList()

suspend fun WorkoutRepository.deleteCoachConversation(id: String) = withAccount {
    supabase.postgrest.from("coach_conversations").delete { filter { eq("id", id) } }
}

suspend fun WorkoutRepository.setCoachConversationPinned(id: String, pinned: Boolean) = withAccount {
    supabase.postgrest.from("coach_conversations")
        .update(mapOf("pinned" to JsonPrimitive(pinned))) { filter { eq("id", id) } }
}

// Raw JSON string back (used when finalizing a template).
suspend fun WorkoutRepository.coachFinalizeRaw(req: CoachChatRequest): String =
    supabase.functions.invoke("coach-chat") {
        setBody(json.encodeToString(CoachChatRequest.serializer(), req))
    }.body()

// Streaming agentic coach chat (SSE): emits a {tool} progress event for each
// tool the coach runs, then the reply text, then {done}.
data class CoachStreamResult(
    val conversationId: String?,
    val toolsUsed: List<String>,
    val error: String?,
    val gotReply: Boolean,
    val settingsChanges: List<ChatSettingChange> = emptyList(),
)

suspend fun WorkoutRepository.coachAgenticStream(
    messages: List<ChatMessage>,
    conversationId: String?,
    incognito: Boolean = false,
    onTool: (String) -> Unit,
    onToken: (String) -> Unit,
    // The coach narrated something, then decided to call a tool instead. What
    // was shown is no longer part of the answer, so drop it.
    onReset: () -> Unit = {},
): CoachStreamResult = withAccount {
    val token = supabase.auth.currentSessionOrNull()?.accessToken
    val url = backend.url.trimEnd('/') + "/functions/v1/coach-chat"
    val payload = json.encodeToString(
        CoachChatRequest.serializer(),
        CoachChatRequest(
            messages = messages, mode = "chat", conversationId = conversationId,
            purpose = "setup", stream = true, incognito = incognito,
        ),
    )

    var convId: String? = null
    var tools: List<String> = emptyList()
    var settingsChanges: List<ChatSettingChange> = emptyList()
    var error: String? = null
    var gotReply = false
    val streamStarted = System.currentTimeMillis()
    AppLog.i("coach", "coach-stream start turns=${messages.size}")
    streamingHttp.preparePost(url) {
        header("Authorization", "Bearer $token")
        header("apikey", backend.anonKey)
        contentType(ContentType.Application.Json)
        setBody(payload)
    }.execute { resp ->
        val channel: ByteReadChannel = resp.bodyAsChannel()
        while (!channel.isClosedForRead) {
            val line = channel.readUTF8Line() ?: break
            if (!line.startsWith("data:")) continue
            val data = line.removePrefix("data:").trim()
            if (data.isEmpty()) continue
            val obj = runCatching { json.parseToJsonElement(data).jsonObject }.getOrNull() ?: continue
            obj["tool"]?.let { onTool(it.jsonPrimitive.content) }
            // Order matters: a reset in the same frame as a token must clear
            // first, and gotReply has to go back to false or a later failure
            // would be swallowed as "we already had a reply".
            if (obj["reset"] != null) { gotReply = false; onReset() }
            obj["token"]?.let { gotReply = true; onToken(it.jsonPrimitive.content) }
            obj["error"]?.let { error = it.jsonPrimitive.contentOrNull }
            if (obj["done"] != null) {
                convId = obj["conversation_id"]?.jsonPrimitive?.contentOrNull
                tools = (obj["tools_used"] as? JsonArray)
                    ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
                settingsChanges = obj["settings_changes"]?.let { el ->
                    runCatching {
                        json.decodeFromJsonElement(
                            ListSerializer(ChatSettingChange.serializer()), el,
                        )
                    }.getOrNull()
                } ?: emptyList()
            }
        }
    }
    AppLog.i(
        "coach",
        "coach-stream done ${System.currentTimeMillis() - streamStarted}ms reply=$gotReply tools=$tools" +
            (error?.let { " error=$it" } ?: ""),
    )
    // The coach may have evolved memory/soul server-side this turn.
    invalidateProfileCache()
    return@withAccount CoachStreamResult(convId, tools, error, gotReply, settingsChanges)
}

// Device settings the coach changed via chat (update_app_settings): apply
// through the app's own whitelist and report what actually changed.
suspend fun WorkoutRepository.applyChatSettings(changes: List<ChatSettingChange>): List<String> =
    runCatching { prefs.applyChatSettings(changes) }.logFailure("applyChatSettings").getOrDefault(emptyList())
