package com.workoutmaker.app.ui.tutorial

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.AppPreferences
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class FeatureTourViewModel @Inject constructor(private val prefs: AppPreferences) : ViewModel() {
    val pending = prefs.featureTourPending.stateIn(viewModelScope, SharingStarted.Eagerly, false)
    fun start() = viewModelScope.launch { prefs.setFeatureTourPending(true) }
    fun dismiss() = viewModelScope.launch { prefs.setFeatureTourPending(false) }
}

internal data class TourFeature(val route: String, val title: String, val description: String, val tip: String)

internal val TOUR_FEATURES = listOf(
    TourFeature("home", "Your day at a glance", "Home brings together your readiness, today's workout and your weekly progress.", "Check in with your energy and soreness. After a session, mark it done and tell your coach how it felt. You can undo a completion on the workout card."),
    TourFeature("coach", "Talk to your coach", "Ask about your training, request a workout or plan your week in Coach.", "Tell your coach what changed: less time, sore legs or a new goal. Ask for changes whenever a plan does not fit your day."),
    TourFeature("calendar", "See your training plan", "Calendar puts your planned sessions and completed activities in one place.", "Tap a day to see its sessions. Open a workout to log it, move it, skip it or correct a completion."),
    TourFeature("strength", "Log your strength sessions", "Start a planned gym workout, use a routine or build a session in Strength.", "Record weights and reps as you go. Rest timers keep you moving, and your history shows your progress."),
    TourFeature("body-history", "Track your body trends", "Body trends shows weight, body fat and muscle trends over time.", "Use Log today to enter any measurements you know. Find this screen again in Settings → About you → Body trends."),
    TourFeature("settings", "Make it yours", "Settings holds your goals, training week, AI model and connected services.", "Keep your availability and constraints up to date. You can replay this guide anytime from App tour in Settings."),
)

@Composable
fun FeatureTourHost(onShowFeature: (String) -> Unit, onDismiss: () -> Unit) {
    var step by rememberSaveable { mutableIntStateOf(-1) }
    LaunchedEffect(step) {
        if (step in TOUR_FEATURES.indices) onShowFeature(TOUR_FEATURES[step].route)
    }
    FeatureTour(
        step = step,
        onStart = { step = 0 },
        onNext = { if (step == TOUR_FEATURES.lastIndex) onDismiss() else step++ },
        onBack = { if (step > 0) step-- },
        onDismiss = onDismiss,
    )
}

@Composable
internal fun FeatureTour(step: Int, onStart: () -> Unit, onNext: () -> Unit, onBack: () -> Unit, onDismiss: () -> Unit) {
    if (step < 0) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("You're ready to train") },
            text = { Text("Take a quick tour of your workouts, coach and progress. You can skip anytime and replay it from Settings.") },
            confirmButton = { Button(onClick = onStart) { Text("Show me around") } },
            dismissButton = { TextButton(onClick = onDismiss) { Text("Skip tutorial") } },
        )
        return
    }
    val feature = TOUR_FEATURES[step]
    Popup(alignment = Alignment.BottomCenter, onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        Surface(
            modifier = Modifier.padding(16.dp).widthIn(max = 480.dp).fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = 8.dp,
            shadowElevation = 12.dp,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary),
        ) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("APP TOUR · ${step + 1} OF ${TOUR_FEATURES.size}", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    TextButton(onClick = onDismiss) { Text("Skip tutorial") }
                }
                Text(feature.title, style = MaterialTheme.typography.titleLarge)
                Text(feature.description, style = MaterialTheme.typography.bodyMedium)
                Text(feature.tip, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = onBack, enabled = step > 0) { Text("Back") }
                    Button(onClick = onNext) { Text(if (step == TOUR_FEATURES.lastIndex) "Finish tour" else "Next") }
                }
            }
        }
    }
}
