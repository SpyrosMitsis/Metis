package com.workoutmaker.app.ui.screens.strength

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.workoutmaker.app.data.PlannedWorkout
import com.workoutmaker.app.data.Workout
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CompletedPlanCardTest {
    @get:Rule val compose = createComposeRule()

    @Test fun undoCompletionRestoresTheStartAction() {
        val plan = mutableStateOf(PlannedWorkout("test", "2026-10-27", "strength", Workout("strength", "Test session"), completed = true))
        var undid = false
        compose.setContent {
            WorkoutMakerTheme {
                TodayPlannedCard(Modifier, plan.value, onStart = {}, onMarkUndone = {
                    undid = true
                    plan.value = plan.value.copy(completed = false)
                })
            }
        }
        compose.onNodeWithText("Mark as not done").assertIsDisplayed().performClick()
        assertEquals(true, undid)
        compose.onNodeWithText("Mark as not done").assertDoesNotExist()
        compose.onNodeWithText("  Start this session").assertIsDisplayed()
    }
}
