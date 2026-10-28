package com.workoutmaker.app.ui.screens.strength

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.workoutmaker.app.strength.ExerciseCatalog
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class StrengthStatsContentTest {
    @get:Rule val compose = createComposeRule()

    @Test fun customDeletionRequiresConfirmationAndRowStillOpensStats() {
        var deleted: String? = null
        var picked: String? = null
        compose.setContent { WorkoutMakerTheme {
            ExerciseStatsPickerScreen(listOf("My exercise"), onPick = { picked = it }, onBack = {},
                customNames = setOf("My exercise"), onDeleteCustom = { deleted = it })
        } }
        compose.onNodeWithText("My exercise").performClick()
        assertEquals("My exercise", picked)
        compose.onNodeWithContentDescription("Options for My exercise").performClick()
        compose.onNodeWithText("Delete custom entry").performClick()
        assertEquals(null, deleted)
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(null, deleted)
        compose.onNodeWithContentDescription("Options for My exercise").performClick()
        compose.onNodeWithText("Delete custom entry").performClick()
        compose.onNodeWithText("Delete", substring = false).performClick()
        assertEquals("My exercise", deleted)
    }

    @Test fun bundledExerciseHasNoDeleteAndHiddenHistoryCanBeRestored() {
        val builtin = ExerciseCatalog.all.first().name
        var restored: String? = null
        compose.setContent { WorkoutMakerTheme {
            ExerciseStatsPickerScreen(listOf(builtin, "Old custom"), onPick = {}, onBack = {},
                hiddenNames = setOf("Old custom"), onRestore = { restored = it })
        } }
        compose.onNodeWithContentDescription("Options for $builtin").assertDoesNotExist()
        compose.onNodeWithText("Old custom").assertDoesNotExist()
        compose.onNodeWithText("Hidden (1)").performClick()
        compose.onNodeWithContentDescription("Restore Old custom").performClick()
        assertEquals("Old custom", restored)
    }

    @Test fun typingKeepsCountdownAndTimerActionsWhileHidingSecondaryButtons() {
        var adjustment = 0
        var skipped = false
        compose.setContent { WorkoutMakerTheme {
            ActiveWorkoutBottomBar(keyboardVisible = true, rest = 75, status = null,
                timer = { RestTimerContent(it, 90, onAdjust = { adjustment = it }, onSkip = { skipped = true }) },
                onAddExercise = {}, onStartRest = {})
        } }
        compose.onNodeWithText("1:15").assertIsDisplayed()
        compose.onNodeWithText(" Add exercise").assertDoesNotExist()
        compose.onNodeWithText("+15s").performClick()
        assertEquals(15, adjustment)
        compose.onNodeWithText("Skip").performClick()
        assertEquals(true, skipped)
    }
}
