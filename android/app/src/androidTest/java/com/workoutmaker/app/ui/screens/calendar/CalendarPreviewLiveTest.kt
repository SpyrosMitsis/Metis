package com.workoutmaker.app.ui.screens.calendar

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.workoutmaker.app.MainActivity
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Opt-in signed-in check: creates a preview only; never applies a plan change. */
class CalendarPreviewLiveTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun previewReturnsAVisibleResultAndTheToolbarHasNoDuplicateActions() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePreview") == "true")
        compose.waitUntil(20_000) { compose.onAllNodesWithText("Calendar").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Calendar").performClick()
        compose.onNodeWithContentDescription("Plan my week").assertDoesNotExist()
        compose.onNodeWithContentDescription("Schedule a template").assertDoesNotExist()
        compose.onNodeWithText("Preview changes").performScrollTo().performClick()
        compose.waitUntil(45_000) { compose.onAllNodesWithText("Available minutes (optional)").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Available minutes (optional)").assertExists()
        compose.onNodeWithText("Could not update the plan. Refresh the preview and try again.").assertDoesNotExist()
    }
}
