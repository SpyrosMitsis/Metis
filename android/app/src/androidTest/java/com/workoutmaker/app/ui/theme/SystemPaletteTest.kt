package com.workoutmaker.app.ui.theme

import android.os.Build
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class SystemPaletteTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun bothModesUseTheSelectedSystemAccentTones() {
        assumeTrue(Build.VERSION.SDK_INT >= 31)
        val dark = systemPaletteScheme(context, true)
        val light = systemPaletteScheme(context, false)
        assertEquals(Color(context.getColor(android.R.color.system_accent1_200)), dark.primary)
        assertEquals(Color(context.getColor(android.R.color.system_accent1_600)), light.primary)
        assertEquals(Color(context.getColor(android.R.color.system_accent2_200)), dark.secondary)
        assertEquals(Color(context.getColor(android.R.color.system_accent3_600)), light.tertiary)
        assertTrue(contrast(dark.primary, dark.onPrimary) >= 4.5)
        assertTrue(contrast(light.primary, light.onPrimary) >= 4.5)
        assertTrue(contrast(dark.background, dark.onBackground) >= 4.5)
        assertTrue(contrast(light.background, light.onBackground) >= 4.5)
    }

    @Test fun samsungDynamicThemeUsesTheSelectedPaletteAndKeepsCardsVisible() {
        assumeTrue(Build.VERSION.SDK_INT >= 34 && Build.MANUFACTURER.equals("samsung", true))
        for (dark in listOf(true, false)) {
            val scheme = dynamicScheme(context, dark)
            val expected = if (dark) android.R.color.system_accent1_200 else android.R.color.system_accent1_600
            assertEquals(Color(context.getColor(expected)), scheme.primary)
            if (dark) assertTrue(scheme.surface.luminance() > scheme.background.luminance())
            else assertTrue(scheme.surface.luminance() > scheme.surfaceContainerLowest.luminance())
        }
    }

    private fun contrast(a: Color, b: Color): Double {
        val l1 = a.luminance().toDouble()
        val l2 = b.luminance().toDouble()
        return (maxOf(l1, l2) + 0.05) / (minOf(l1, l2) + 0.05)
    }
}
