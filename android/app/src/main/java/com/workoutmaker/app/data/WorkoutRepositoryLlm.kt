package com.workoutmaker.app.data

import com.workoutmaker.app.util.runCatching

import io.github.jan.supabase.functions.functions
import io.github.jan.supabase.postgrest.postgrest
import io.ktor.client.call.body
import io.ktor.client.request.setBody
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject

// --- Pro plan / hosted AI ------------------------------------------------

// Whether THIS deployment offers hosted AI, from the last cached summary —
// offline-friendly and never blocks Settings on a network call.
suspend fun WorkoutRepository.serverHostedAi(): Boolean = runCatching {
    cache.latestSummary()?.let {
        json.decodeFromString(DailySummary.serializer(), it.json).server?.hosted_ai
    } ?: false
}.logFailure("serverHostedAi").getOrDefault(false)

suspend fun WorkoutRepository.planStatus(): PlanStatus = runCatching {
    val row = profileRow()
    PlanStatus(
        plan = (row?.get("plan") as? JsonPrimitive)?.contentOrNull ?: "free",
        expiresAt = (row?.get("plan_expires_at") as? JsonPrimitive)?.contentOrNull,
        useHostedAi = (row?.get("use_hosted_ai") as? JsonPrimitive)?.contentOrNull?.toBoolean() ?: true,
    )
}.logFailure("planStatus").getOrDefault(PlanStatus())

suspend fun WorkoutRepository.setUseHostedAi(on: Boolean) = withAccount {
    supabase.postgrest.from("user_profiles").update({ set("use_hosted_ai", on) }) {
        filter { eq("id", uid()) }
    }
    invalidateProfileCache()
}

// Server-side verification of a Play purchase; the fn is the only writer
// of the plan columns. Returns the resulting plan ("pro" on success).
suspend fun WorkoutRepository.verifyPurchase(purchaseToken: String): String = withAccount {
    val body = buildJsonObject {
        put("purchase_token", JsonPrimitive(purchaseToken))
    }.toString()
    val res: Map<String, JsonElement> = json.decodeFromString(
        supabase.functions.invoke("verify-purchase") { setBody(body) }.body(),
    )
    invalidateProfileCache()
    (res["error"] as? JsonPrimitive)?.contentOrNull?.let { throw IllegalStateException(it) }
    return@withAccount (res["plan"] as? JsonPrimitive)?.contentOrNull ?: "free"
}

// Per-1M-token prices for the custom (BYO) provider, so its spend isn't $0.
suspend fun WorkoutRepository.customLlmPricing(): Pair<Double?, Double?> = runCatching {
    val row = profileRow()
    val inp = (row?.get("llm_custom_input_per_1m") as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
    val out = (row?.get("llm_custom_output_per_1m") as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
    inp to out
}.logFailure("customLlmPricing").getOrDefault(null to null)

suspend fun WorkoutRepository.setCustomLlmPricing(inputPer1M: Double?, outputPer1M: Double?) = withAccount {
    val obj = buildJsonObject {
        put("llm_custom_input_per_1m", inputPer1M?.let { JsonPrimitive(it) } ?: JsonNull)
        put("llm_custom_output_per_1m", outputPer1M?.let { JsonPrimitive(it) } ?: JsonNull)
    }
    supabase.postgrest.from("user_profiles").update(obj) { filter { eq("id", uid()) } }
    invalidateProfileCache()
}

suspend fun WorkoutRepository.setActiveProvider(provider: LlmProvider) = withAccount {
    supabase.postgrest.from("user_profiles").update(mapOf("active_llm_provider" to provider.key)) {
        filter { eq("id", uid()) }
    }
    invalidateProfileCache()
}

// --- Dynamic model selection ---------------------------------------------
suspend fun WorkoutRepository.listModels(provider: LlmProvider): ModelListResponse =
    json.decodeFromString(
        supabase.functions.invoke("list-models") {
            setBody(
                buildJsonObject {
                    put("provider", JsonPrimitive(provider.key))
                }.toString(),
            )
        }.body(),
    )

// Per-provider model override (user_profiles.llm_models). Empty map → defaults.
suspend fun WorkoutRepository.modelOverrides(): Map<String, String> = runCatching {
    (profileRow()?.get("llm_models") as? JsonObject)
        ?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.contentOrNull?.let { k to it } }
        ?.toMap() ?: emptyMap()
}.logFailure("modelOverrides").getOrDefault(emptyMap())

suspend fun WorkoutRepository.setModelOverride(provider: LlmProvider, model: String?) = withAccount {
    val current = modelOverrides().toMutableMap()
    if (model.isNullOrBlank()) current.remove(provider.key) else current[provider.key] = model
    val obj = buildJsonObject {
        current.forEach { (k, v) -> put(k, JsonPrimitive(v)) }
    }
    supabase.postgrest.from("user_profiles").update(mapOf("llm_models" to obj)) {
        filter { eq("id", uid()) }
    }
    invalidateProfileCache()
}
