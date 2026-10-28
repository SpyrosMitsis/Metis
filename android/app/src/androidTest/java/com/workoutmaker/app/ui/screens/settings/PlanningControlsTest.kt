package com.workoutmaker.app.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class PlanningControlsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun specialistControlsStayAvailableWithoutChangingProfileOnOpen() {
        var updates = 0
        compose.setContent {
            WorkoutMakerTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    PlanningControls(TrainingProfile()) { updates++ }
                }
            }
        }
        compose.onNodeWithText("Performance tests").assertExists()
        compose.onNodeWithText("Add calibration").assertDoesNotExist()
        compose.onNodeWithText("Performance tests").performScrollTo().performClick()
        compose.onNodeWithText("Add calibration").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, updates) }
    }

    @Test fun collapsingPerformanceTestsPreservesAnUnfinishedMeasurement() {
        compose.setContent {
            WorkoutMakerTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    PlanningControls(TrainingProfile()) { }
                }
            }
        }
        compose.onNodeWithText("Performance tests").performScrollTo().performClick()
        compose.onNodeWithText("Measurement value").performScrollTo().performTextInput("300")
        compose.onNodeWithText("Performance tests").performScrollTo().performClick()
        compose.onNodeWithText("Measurement value").assertDoesNotExist()
        compose.onNodeWithText("Performance tests").performScrollTo().performClick()
        compose.onNodeWithText("Measurement value").performScrollTo().assertTextContains("300")
    }
}
