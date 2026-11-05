package com.workoutmaker.app.data

import io.github.jan.supabase.functions.functions
import io.github.jan.supabase.postgrest.postgrest
import io.ktor.client.request.setBody
import kotlinx.serialization.json.*

suspend fun WorkoutRepository.restrictions(): List<JsonObject> = withAccount {
    val row = supabase.postgrest.from("user_profiles").select { filter { eq("id", uid()) } }.decodeList<JsonObject>().single()
    (row["injury_backoff"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
}

suspend fun WorkoutRepository.saveRestriction(expected: JsonObject, level: String, until: String, sports: List<String>) = withAccount {
    supabase.functions.invoke("injury-checkin") {
        setBody(buildJsonObject {
            put("kind", "restriction"); put("area", expected["area"]!!); put("expected", expected)
            put("level", level); put("until", until); put("sports", JsonArray(sports.map(::JsonPrimitive)))
        }.toString())
    }
    invalidateProfileCache()
}
