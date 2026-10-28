package com.workoutmaker.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.*
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.util.runCatching
import com.workoutmaker.app.util.AppLog
import com.workoutmaker.app.util.friendlyFnError
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel class AdaptationViewModel @Inject constructor(private val repo:WorkoutRepository,private val changes:PlanChangeBus):ViewModel() {
    val applyAllowed=MutableStateFlow(false);val inventory=MutableStateFlow<List<String>>(emptyList());val proposal=MutableStateFlow<AdaptationProposal?>(null);val history=MutableStateFlow<List<AdaptationProposal>>(emptyList());val holds=MutableStateFlow<List<PlanningHold>>(emptyList());val busy=MutableStateFlow(false);val message=MutableStateFlow<String?>(null)
    fun run(action:String="preview",id:String?=null,minutes:Int?=null,unavailable:List<String> = emptyList(),alternative:String?=null)=viewModelScope.launch {
        if(busy.value)return@launch
        busy.value=true;message.value=null
        runCatching { repo.adaptation(action,id,minutes,unavailable,alternative) }.onSuccess { r ->
            if(action=="history"){history.value=r.history;if(r.history.isEmpty())message.value="No plan adjustments yet."} else {proposal.value=r.proposal;applyAllowed.value=r.apply_allowed}
            if(action in listOf("apply","undo")){changes.emit("adaptation");message.value=if(action=="undo")"Previous sessions restored." else "Changes applied."}
            if(r.sync_error!=null)message.value="Plan saved; calendar sync will retry."
        }.onFailure { AppLog.w("adaptation", "$action failed", it); message.value=friendlyFnError(it,"Could not update the plan. Refresh the preview and try again.") }
        busy.value=false
    }
    fun loadHolds()=viewModelScope.launch { runCatching {repo.loadProfile()}.onSuccess{inventory.value=it?.implements.orEmpty()};runCatching { repo.planningHolds() }.onSuccess { holds.value=it } }
    fun clearHold(id:String)=viewModelScope.launch { runCatching {repo.resolvePlanningHold(id)}.onSuccess {loadHolds();changes.emit("hold-cleared")}.onFailure {message.value="Could not clear the planning hold."} }
}

data class AdaptationUiState(val proposal:AdaptationProposal?=null,val history:List<AdaptationProposal> = emptyList(),val holds:List<PlanningHold> = emptyList(),val inventory:List<String> = emptyList(),val applyAllowed:Boolean=false,val busy:Boolean=false,val message:String?=null)
interface AdaptationActions {
    fun run(action:String="preview",id:String?=null,minutes:Int?=null,unavailable:List<String> = emptyList(),alternative:String?=null)
    fun clearHold(id:String) {}
}

@Composable fun AdaptationControls(vm:AdaptationViewModel=hiltViewModel()) {
    val applyAllowed by vm.applyAllowed.collectAsStateSafe();val inventory by vm.inventory.collectAsStateSafe();val proposal by vm.proposal.collectAsStateSafe();val history by vm.history.collectAsStateSafe();val holds by vm.holds.collectAsStateSafe();val busy by vm.busy.collectAsStateSafe();val message by vm.message.collectAsStateSafe()
    LaunchedEffect(Unit){vm.loadHolds()}
    AdaptationContent(AdaptationUiState(proposal,history,holds,inventory,applyAllowed,busy,message),object:AdaptationActions {
        override fun run(action:String,id:String?,minutes:Int?,unavailable:List<String>,alternative:String?){vm.run(action,id,minutes,unavailable,alternative)}
        override fun clearHold(id:String){vm.clearHold(id)}
    })
}
@Composable fun AdaptationContent(state:AdaptationUiState,actions:AdaptationActions) {
    val proposal=state.proposal;val history=state.history;val holds=state.holds;val inventory=state.inventory;val applyAllowed=state.applyAllowed;val busy=state.busy;val message=state.message
    var minutes by remember {mutableStateOf("")};var equipment by remember {mutableStateOf<List<String>>(emptyList())};var inspected by remember {mutableStateOf<String?>(null)}
    SectionCard {
        SectionLabel("Adjust my plan")
        Text("Preview only the sessions that need changing. Completed training and locked commitments stay in place.",style=MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            TextButton({actions.run()},enabled=!busy){Text(if(busy)"Checking…" else "Preview changes")}
            TextButton({actions.run("history")},enabled=!busy){Text("History")}
        }
        proposal?.let { p ->
            if(p.state=="preview"&&p.changes.isEmpty()&&p.clarification==null)Text("No changes needed",style=MaterialTheme.typography.titleMedium)
            Text(p.explanation);Text(p.next_action,style=MaterialTheme.typography.bodyMedium)
            p.uncertainties.forEach {Text(it,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
            p.changes.forEach {c->
                Text("${c.date} · session ${c.session_slot+1}",style=MaterialTheme.typography.labelMedium)
                Text("${c.before.title} (${c.before.duration_minutes} min) → ${c.after.title} (${c.after.duration_minutes} min)")
                c.after.sections.forEach {s->Text(s.exercises.joinToString {it.name+" · "+it.reps},style=MaterialTheme.typography.bodySmall)}
            }
            if(p.clarification!=null){
                Text(p.clarification)
                inventory.forEach {item->Row {Checkbox(item in equipment,{checked->equipment=if(checked)equipment+item else equipment-item});Text(item.replace('_',' '))}}
                TextButton({actions.run(unavailable=equipment)},enabled=!busy){Text("Update preview")}
            }
            OutlinedTextField(minutes,{minutes=it.filter(Char::isDigit)},label={Text("Available minutes (optional)")},singleLine=true)
            if(minutes.isNotBlank())TextButton({actions.run(minutes=minutes.toIntOrNull())},enabled=!busy){Text("Preview shorter session")}
            p.alternatives.forEach {a->TextButton({actions.run(alternative=a.id)},enabled=!busy){Text(a.label)}}
            if(p.state=="preview"&&p.changes.isNotEmpty()&&!applyAllowed)Text("Plan adjustments are currently available as previews.",style=MaterialTheme.typography.bodySmall)
            if(applyAllowed&&p.state=="preview"&&p.changes.isNotEmpty()&&p.clarification==null)Button({actions.run("apply",p.id)},enabled=!busy){Text("Apply these changes")}
            if(p.state=="applied")TextButton({actions.run("undo",p.id)},enabled=!busy){Text("Undo adaptation")}
        }
        history.forEach {p->
            TextButton({inspected=if(inspected==p.id)null else p.id}){Text("${p.created_at?.take(10).orEmpty()} · ${p.state} · ${p.changes.size} changes")}
            if(inspected==p.id){Text(p.explanation);p.changes.forEach {c->Text("${c.date}: ${c.before.title} → ${c.after.title}",style=MaterialTheme.typography.bodySmall)};if(p.state=="applied")TextButton({actions.run("undo",p.id)},enabled=!busy){Text("Undo this adaptation")}}
        }
        holds.forEach {h->
            Text("Planning hold: ${h.reason}${h.sport?.let{" · $it"}.orEmpty()}${h.area?.let{" · $it"}.orEmpty()}")
            Text("Clearing this resumes planning; it is not medical clearance.",style=MaterialTheme.typography.bodySmall)
            TextButton({actions.clearHold(h.id)},enabled=!busy){Text("Clear planning hold")}
        }
        message?.let {Text(it,style=MaterialTheme.typography.bodySmall)}
    }
}
