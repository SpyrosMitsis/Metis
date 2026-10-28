package com.workoutmaker.app.data

import io.github.jan.supabase.functions.functions
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.rpc
import io.ktor.client.call.body
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import java.time.LocalDate
import kotlinx.serialization.json.*

suspend fun WorkoutRepository.adaptation(action:String="preview", proposalId:String?=null, minutes:Int?=null, unavailable:List<String> = emptyList(), alternative:String?=null):AdaptationResponse = withAccount {
    json.decodeFromString(supabase.functions.invoke("adapt-plan") { contentType(ContentType.Application.Json); setBody(buildJsonObject {
        put("action",action);put("today",LocalDate.now().toString())
        proposalId?.let { put("proposal_id",it) };minutes?.let { put("minutes",it) }
        put("unavailable_implements",JsonArray(unavailable.map(::JsonPrimitive)))
        alternative?.let { put("alternative_sport",it) }
    }.toString()) }.body())
}
suspend fun WorkoutRepository.planningHolds():List<PlanningHold> = withAccount {
    supabase.postgrest.from("training_holds").select { filter { eq("active",true) } }.decodeList()
}
suspend fun WorkoutRepository.resolvePlanningHold(id:String) = withAccount {
    supabase.postgrest.rpc("resolve_training_hold",buildJsonObject { put("p_id",id) })
}
