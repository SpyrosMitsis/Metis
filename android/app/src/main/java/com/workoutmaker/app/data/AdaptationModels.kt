package com.workoutmaker.app.data

import kotlinx.serialization.Serializable

@Serializable data class AdaptationChange(val id:String,val date:String,val session_slot:Int=0,val before:Workout,val after:Workout,val explanation:String)
@Serializable data class AdaptationProposal(val id:String,val state:String="preview",val created_at:String?=null,val changes:List<AdaptationChange> = emptyList(),val explanation:String="",val next_action:String="",val uncertainties:List<String> = emptyList(),val alternatives:List<AdaptationAlternative> = emptyList(),val clarification:String?=null)
@Serializable data class AdaptationAlternative(val id:String,val label:String)
@Serializable data class AdaptationResponse(val proposal:AdaptationProposal?=null,val history:List<AdaptationProposal> = emptyList(),val sync_error:String?=null,val apply_allowed:Boolean=false)
@Serializable data class PlanningHold(val id:String,val reason:String,val sport:String?=null,val area:String?=null,val active:Boolean=true)
