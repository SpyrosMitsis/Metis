package com.workoutmaker.app.ui.screens.settings

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.workoutmaker.app.MainActivity
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Explicit opt-in: exercises the signed-in app and spends a real coach turn.
 * adb shell am instrument -w -e liveCoach true -e class <this class> ...
 * Never generates a workout, creates a goal or changes the athlete's plan.
 */
class CoachTodayLiveTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun askingAboutTodayReadsTheExistingPlan() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveCoach") == "true")
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Coach").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Coach").performClick()
        compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("New chat").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("New chat").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("What do I need to do today?")
        compose.onNodeWithContentDescription("Send").performClick()

        fun texts() = compose.onAllNodes(hasText("", substring = true)).fetchSemanticsNodes()
            .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
        compose.waitUntil(120_000) {
            val visible = texts()
            visible.any { it.length > 120 } && visible.none { it.startsWith("Coach is thinking") || it.startsWith("Reading today") || it.startsWith("Checking your") || it.startsWith("Reviewing recent") }
        }
        val result = texts().joinToString("\n")
        val directory = File(compose.activity.getExternalFilesDir(null), "coach-live-check").apply { mkdirs() }
        File(directory, "reply.txt").writeText(result)
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { screenshot ->
            File(directory, "reply.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        assertFalse(result.contains("couldn't complete the calendar update", ignoreCase = true))
        assertFalse(result.contains("UPDATED YOUR CALENDAR", ignoreCase = true))
        assertFalse(result.contains("Coach proposed this but didn't apply it", ignoreCase = true))
        compose.onAllNodesWithText("📅 Put it on my calendar").assertCountEquals(0)
        compose.onNodeWithContentDescription("Send").assertExists()
    }
}
