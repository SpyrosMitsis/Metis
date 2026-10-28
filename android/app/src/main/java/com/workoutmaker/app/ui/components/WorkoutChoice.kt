package com.workoutmaker.app.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.workoutmaker.app.data.workoutFocuses
import com.workoutmaker.app.data.workoutSports

@Composable
fun WorkoutChoice(sport: String, focus: String, onSport: (String) -> Unit, onFocus: (String) -> Unit, enabled: Boolean = true) {
    Column {
        ChoiceMenu("Sport", workoutSports[sport] ?: "Coach's choice", workoutSports, enabled) {
            onSport(it)
            onFocus("")
        }
        if (sport != "auto") ChoiceMenu("Session focus", focus.ifBlank { "Coach's choice" },
            linkedMapOf("" to "Coach's choice") + workoutFocuses(sport).associateWith { it }, enabled, onFocus)
    }
}

@Composable
private fun ChoiceMenu(label: String, selected: String, options: Map<String, String>, enabled: Boolean, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
            Text("$label: $selected ▾")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (key, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(key); expanded = false })
            }
        }
    }
}
