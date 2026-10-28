package com.workoutmaker.app.ui.tutorial

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class FeatureTourTest {
    @get:Rule val compose = createComposeRule()

    @Test fun welcomeCanBeSkippedWithoutNavigating() {
        var dismissed = false
        val routes = mutableListOf<String>()
        compose.setContent { WorkoutMakerTheme { FeatureTourHost({ routes += it }, { dismissed = true }) } }
        compose.onNodeWithText("You're ready to train").assertIsDisplayed()
        compose.onNodeWithText("Skip tutorial").performClick()
        assertEquals(true, dismissed)
        assertEquals(emptyList<String>(), routes)
    }

    @Test fun guideVisitsEveryFeatureSupportsBackAndFinishes() {
        val visible = mutableStateOf(true)
        val routes = mutableListOf<String>()
        compose.setContent {
            WorkoutMakerTheme {
                if (visible.value) FeatureTourHost({ routes += it }, { visible.value = false })
            }
        }
        compose.onNodeWithText("Show me around").performClick()
        compose.onNodeWithText(TOUR_FEATURES.first().title).assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithText("Back").performClick()
        compose.waitForIdle()
        assertEquals(listOf("home", "coach", "home"), routes)
        for (i in 1..TOUR_FEATURES.lastIndex) {
            compose.onNodeWithText("Next").performClick()
            compose.onNodeWithText(TOUR_FEATURES[i].title).assertIsDisplayed()
        }
        compose.onNodeWithText("Finish tour").performClick()
        compose.onNodeWithText("Finish tour").assertDoesNotExist()
        assertEquals(TOUR_FEATURES.map { it.route }, routes.takeLast(TOUR_FEATURES.size))
    }

    @Test fun guideCanBeSkippedMidway() {
        val visible = mutableStateOf(true)
        compose.setContent { WorkoutMakerTheme { if (visible.value) FeatureTourHost({}, { visible.value = false }) } }
        compose.onNodeWithText("Show me around").performClick()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithText("Skip tutorial").performClick()
        compose.onNodeWithText("Skip tutorial").assertDoesNotExist()
    }
}
