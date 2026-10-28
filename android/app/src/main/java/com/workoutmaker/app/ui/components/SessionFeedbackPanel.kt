package com.workoutmaker.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.*
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.util.friendlyFnError
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel class SessionFeedbackViewModel @Inject constructor(private val repo:WorkoutRepository,private val changes:PlanChangeBus):ViewModel() {
    val messageFor=MutableStateFlow("");val busy=MutableStateFlow(false);val message=MutableStateFlow<String?>(null)
    fun save(feedback:WorkoutFeedback)=viewModelScope.launch {
        if(busy.value)return@launch
        busy.value=true;messageFor.value=feedback.id;message.value=null
        runCatching{repo.submitFeedback(feedback)}.onSuccess{message.value="Feedback saved. Adaptation uses what you actually did.";changes.emit("session-feedback")}.onFailure{message.value=friendlyFnError(it,"Could not save feedback. Try again.")};busy.value=false
    }
}
@Composable internal fun FeedbackChoice(label:String,value:String,options:List<String>,onChange:(String)->Unit){
    var expanded by remember{mutableStateOf(false)}
    Box {OutlinedButton({expanded=true},modifier=Modifier.fillMaxWidth()){Text("$label: ${value.replace('_',' ')}")};DropdownMenu(expanded,{expanded=false}){options.forEach{v->DropdownMenuItem(text={Text(v.replace('_',' '))},onClick={expanded=false;onChange(v)})}}}
}
@Composable fun SessionFeedbackPanel(date:String,planId:String?=null,activityId:String?=null,vm:SessionFeedbackViewModel=hiltViewModel()) {
    key(date,planId,activityId) { SessionFeedbackForm(date,planId,activityId,vm) }
}
@Composable private fun SessionFeedbackForm(date:String,planId:String?,activityId:String?,vm:SessionFeedbackViewModel) {
    var expanded by remember(date,planId,activityId){mutableStateOf(false)}
    var difficulty by remember{mutableStateOf("not rated")};var reason by remember{mutableStateOf("unknown")};var outcome by remember{mutableStateOf("unknown")};var rpe by remember{mutableStateOf("")};var minutes by remember{mutableStateOf("")};var area by remember{mutableStateOf("")};var soreness by remember{mutableStateOf("")};var enjoyment by remember{mutableStateOf("not rated")};var useful by remember{mutableStateOf("not rated")};var unwanted by remember{mutableStateOf(false)}
    val id=remember(date,planId,activityId,reason,outcome,difficulty,rpe,minutes,area,soreness,enjoyment,useful,unwanted){java.util.UUID.randomUUID().toString()};val messageFor by vm.messageFor.collectAsStateSafe();val busy by vm.busy.collectAsStateSafe();val message by vm.message.collectAsStateSafe()
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        TextButton({expanded=!expanded}){Text(if(expanded)"Hide session feedback" else "Session feedback (optional)")}
        if(expanded){
            FeedbackChoice("What happened",outcome,listOf("as_planned","skipped","shortened","easier","harder","substituted","unknown")){outcome=it}
            FeedbackChoice("Session fit",difficulty,listOf("not rated","too_easy","just_right","too_hard")){difficulty=it}
            FeedbackChoice("Reason",reason,listOf("time","fatigue","pain","illness","equipment","conditions","preference","other","unknown")){reason=it}
            OutlinedTextField(rpe,{rpe=it.filter(Char::isDigit).take(2)},label={Text("Perceived effort 1–10 (optional)")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),singleLine=true)
            OutlinedTextField(minutes,{minutes=it.filter{c->c.isDigit()||c=='.'}},label={Text("Actual minutes (optional)")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Decimal),singleLine=true)
            OutlinedTextField(soreness,{soreness=it.take(100)},label={Text("Soreness location (optional)")})
            if(reason=="pain")OutlinedTextField(area,{area=it.take(100)},label={Text("Pain location")})
            if(reason in listOf("pain","illness"))Text("This places affected planning on hold until you review and clear it in Adjust my plan. Pain and soreness are treated separately.",style=MaterialTheme.typography.bodySmall)
            FeedbackChoice("Enjoyment",enjoyment,listOf("not rated","1","2","3","4","5")){enjoyment=it}
            FeedbackChoice("Useful workout",useful,listOf("not rated","1","2","3","4","5")){useful=it}
            Row {Checkbox(unwanted,{unwanted=it});Text("An unwanted plan change affected this session")}
            Button({vm.save(WorkoutFeedback(id=id,date=date,planned_workout_id=planId,activity_id=activityId,completed=outcome !in listOf("skipped","unknown"),reason=reason,outcome=outcome,actual_rpe=rpe.toIntOrNull(),difficulty=difficulty.takeIf{it!="not rated"},actual_minutes=minutes.toDoubleOrNull(),pain_area=area.ifBlank{null},soreness_area=soreness.ifBlank{null},enjoyment=enjoyment.toIntOrNull(),usefulness=useful.toIntOrNull(),unwanted_change=unwanted))},enabled=!busy&&(rpe.isBlank()||rpe.toIntOrNull()?.let{it in 1..10}==true)&&(minutes.isBlank()||minutes.toDoubleOrNull()?.let{it in 0.0..1440.0}==true)){Text(if(busy)"Saving…" else "Save feedback")}
            message?.takeIf{messageFor==id}?.let{Text(it,style=MaterialTheme.typography.bodySmall)}
        }
    }
}
