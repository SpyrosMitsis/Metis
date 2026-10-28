package com.workoutmaker.app.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.workoutmaker.app.data.workoutChoiceRequest
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class WorkoutChoiceTest {
    @get:Rule val compose = createComposeRule()

    @Test fun changingSportClearsTheOldFocusAndSupportsLowerBodyAndStrides() {
        var request = ""
        compose.setContent {
            var sport by remember { mutableStateOf("strength") }
            var focus by remember { mutableStateOf("Upper body") }
            request = workoutChoiceRequest(sport, focus)
            WorkoutMakerTheme {
                WorkoutChoice(sport, focus, { sport = it }, { focus = it })
            }
        }
        compose.onNodeWithText("Session focus: Upper body ▾").performClick()
        compose.onNodeWithText("Lower body").performClick()
        compose.onNodeWithText("Session focus: Lower body ▾").assertIsDisplayed()
        compose.runOnIdle { assertEquals("Make this a strength workout focused on lower body.", request) }
        compose.onNodeWithText("Sport: Strength ▾").performClick()
        compose.onNodeWithText("Running").performClick()
        compose.onNodeWithText("Session focus: Coach's choice ▾").assertIsDisplayed()
        compose.onNodeWithText("Session focus: Coach's choice ▾").performClick()
        compose.onNodeWithText("Strides").performClick()
        compose.onNodeWithText("Session focus: Strides ▾").assertIsDisplayed()
        compose.runOnIdle { assertEquals("Make this a running workout focused on strides.", request) }
    }
}
