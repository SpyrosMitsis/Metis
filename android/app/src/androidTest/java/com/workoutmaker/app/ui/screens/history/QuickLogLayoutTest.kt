package com.workoutmaker.app.ui.screens.history

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class QuickLogLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test fun narrowFormHasEqualInputsWithLargeTextAndAcceptsPartialMeasurements() {
        var saved: List<Double?>? = null
        compose.setContent {
            val density = LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(density, fontScale = 1.5f)) {
                WorkoutMakerTheme {
                    Box(Modifier.width(344.dp)) { QuickLogCard { w, f, l -> saved = listOf(w, f, l) } }
                }
            }
        }
        val inputs = listOf("Weight, kg", "Fat, %", "Muscle, kg").map { compose.onNodeWithContentDescription(it) }
        val bounds = inputs.map { it.fetchSemanticsNode().boundsInRoot }
        bounds.forEach {
            assertEquals(bounds.first().top, it.top, 1f)
            assertEquals(bounds.first().bottom, it.bottom, 1f)
            assertEquals(bounds.first().width, it.width, 1f)
        }
        compose.onNodeWithText("Save measurement").assertIsNotEnabled()
        inputs.first().performTextInput("84.5")
        compose.onNodeWithText("Save measurement").performClick()
        assertEquals(listOf(84.5, null, null), saved)
    }
}
