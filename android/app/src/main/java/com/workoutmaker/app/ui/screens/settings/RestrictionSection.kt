package com.workoutmaker.app.ui.screens.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.SectionCard
import kotlinx.serialization.json.*

@Composable
internal fun RestrictionSection(vm: SettingsViewModel) {
    val entries by vm.restrictions.collectAsStateSafe()
    val status by vm.restrictionStatus.collectAsStateSafe()
    val busy by vm.restrictionBusy.collectAsStateSafe()
    LaunchedEffect(vm) { vm.loadRestrictions() }
    SectionCard(title = "Training restrictions") {
        Text("Review which activities are affected. Uncheck an activity that doesn’t bother you; movement restrictions remain.")
        if (entries.isEmpty()) Text("No saved restrictions.")
        entries.forEach { entry ->
            val area = entry["area"]?.jsonPrimitive?.content.orEmpty()
            var level by remember(entry) { mutableStateOf(entry["level"]?.jsonPrimitive?.content ?: "ease") }
            var until by remember(entry) { mutableStateOf(entry["until"]?.jsonPrimitive?.content.orEmpty()) }
            val storedSports = entry["sports"] as? JsonArray
            var sports by remember(entry) { mutableStateOf<List<String>>(storedSports?.map { it.jsonPrimitive.content } ?: emptyList()) }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(area, style = MaterialTheme.typography.titleSmall)
                Text("Source: " + when (entry["source"]?.jsonPrimitive?.contentOrNull) { "coach" -> "Coach"; "pain_checkin" -> "Pain check-in"; "user" -> "Edited by you"; else -> "Not recorded for this older restriction" }, style = MaterialTheme.typography.bodySmall)
                entry["reason"]?.jsonPrimitive?.contentOrNull?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                if (until < java.time.LocalDate.now().toString()) Text("Expired", style = MaterialTheme.typography.labelSmall)
                entry["set_at"]?.jsonPrimitive?.contentOrNull?.let { Text("Recorded $it", style = MaterialTheme.typography.bodySmall) }
                if (storedSports == null) Text("Older restriction: activity scope needs review. Select affected activities before saving.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = level == "ease", onClick = { level = "ease" }, label = { Text("Ease") }, enabled = !busy)
                    FilterChip(selected = level == "avoid", onClick = { level = "avoid" }, label = { Text("Avoid") }, enabled = !busy)
                }
                listOf("run", "ride", "swim").forEach { sport ->
                    Row {
                        Checkbox(checked = sport in sports, enabled = !busy, onCheckedChange = { checked -> sports = if (checked) (sports + sport).distinct() else sports - sport })
                        Text(sportLabel(sport), modifier = Modifier.padding(top = 12.dp))
                    }
                }
                OutlinedTextField(until, { until = it }, label = { Text("Until (YYYY-MM-DD, inclusive)") }, enabled = !busy, singleLine = true)
                Button(onClick = { vm.saveRestriction(entry, level, until, sports) }, enabled = !busy) { Text("Save restriction") }
            }
        }
        status?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall) } }
    }
}
