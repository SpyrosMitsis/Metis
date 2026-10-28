package com.workoutmaker.app.ui.theme

import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

/**
 * Samsung can overlay the selected Color palette on the Android 12 tonal resources
 * while leaving Android 14's semantic color resources on their default blue palette.
 * Read the selected tonal resources on those devices. Other manufacturers keep the
 * standard Material 3 path, including its system contrast adjustments.
 *
 * Role tones follow Material 3's Android 12/13 dynamic schemes. Intermediate surface
 * tones are interpolated between the public system tones.
 */
@RequiresApi(Build.VERSION_CODES.S)
internal fun systemPaletteScheme(context: Context, dark: Boolean): ColorScheme {
    val primary = SystemTones(context, intArrayOf(
        android.R.color.system_accent1_1000, android.R.color.system_accent1_900,
        android.R.color.system_accent1_800, android.R.color.system_accent1_700,
        android.R.color.system_accent1_600, android.R.color.system_accent1_500,
        android.R.color.system_accent1_400, android.R.color.system_accent1_300,
        android.R.color.system_accent1_200, android.R.color.system_accent1_100,
        android.R.color.system_accent1_50, android.R.color.system_accent1_10,
        android.R.color.system_accent1_0,
    ))
    val secondary = SystemTones(context, intArrayOf(
        android.R.color.system_accent2_1000, android.R.color.system_accent2_900,
        android.R.color.system_accent2_800, android.R.color.system_accent2_700,
        android.R.color.system_accent2_600, android.R.color.system_accent2_500,
        android.R.color.system_accent2_400, android.R.color.system_accent2_300,
        android.R.color.system_accent2_200, android.R.color.system_accent2_100,
        android.R.color.system_accent2_50, android.R.color.system_accent2_10,
        android.R.color.system_accent2_0,
    ))
    val tertiary = SystemTones(context, intArrayOf(
        android.R.color.system_accent3_1000, android.R.color.system_accent3_900,
        android.R.color.system_accent3_800, android.R.color.system_accent3_700,
        android.R.color.system_accent3_600, android.R.color.system_accent3_500,
        android.R.color.system_accent3_400, android.R.color.system_accent3_300,
        android.R.color.system_accent3_200, android.R.color.system_accent3_100,
        android.R.color.system_accent3_50, android.R.color.system_accent3_10,
        android.R.color.system_accent3_0,
    ))
    val neutral = SystemTones(context, intArrayOf(
        android.R.color.system_neutral2_1000, android.R.color.system_neutral2_900,
        android.R.color.system_neutral2_800, android.R.color.system_neutral2_700,
        android.R.color.system_neutral2_600, android.R.color.system_neutral2_500,
        android.R.color.system_neutral2_400, android.R.color.system_neutral2_300,
        android.R.color.system_neutral2_200, android.R.color.system_neutral2_100,
        android.R.color.system_neutral2_50, android.R.color.system_neutral2_10,
        android.R.color.system_neutral2_0,
    ))
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = primary[if (dark) 80 else 40],
        onPrimary = primary[if (dark) 20 else 100],
        primaryContainer = primary[if (dark) 30 else 90],
        onPrimaryContainer = primary[if (dark) 90 else 10],
        inversePrimary = primary[if (dark) 40 else 80],
        secondary = secondary[if (dark) 80 else 40],
        onSecondary = secondary[if (dark) 20 else 100],
        secondaryContainer = secondary[if (dark) 30 else 90],
        onSecondaryContainer = secondary[if (dark) 90 else 10],
        tertiary = tertiary[if (dark) 80 else 40],
        onTertiary = tertiary[if (dark) 20 else 100],
        tertiaryContainer = tertiary[if (dark) 30 else 90],
        onTertiaryContainer = tertiary[if (dark) 90 else 10],
        background = neutral[if (dark) 6 else 98],
        onBackground = neutral[if (dark) 90 else 10],
        surface = neutral[if (dark) 6 else 98],
        onSurface = neutral[if (dark) 90 else 10],
        surfaceVariant = neutral[if (dark) 30 else 90],
        onSurfaceVariant = neutral[if (dark) 80 else 30],
        inverseSurface = neutral[if (dark) 90 else 20],
        inverseOnSurface = neutral[if (dark) 20 else 95],
        outline = neutral[if (dark) 60 else 50],
        outlineVariant = neutral[if (dark) 30 else 80],
        scrim = neutral[0],
        surfaceBright = neutral[if (dark) 24 else 98],
        surfaceDim = neutral[if (dark) 6 else 87],
        surfaceContainer = neutral[if (dark) 12 else 94],
        surfaceContainerHigh = neutral[if (dark) 17 else 92],
        surfaceContainerHighest = neutral[if (dark) 22 else 90],
        surfaceContainerLow = neutral[if (dark) 10 else 96],
        surfaceContainerLowest = neutral[if (dark) 4 else 100],
        surfaceTint = primary[if (dark) 80 else 40],
    )
}

private class SystemTones(context: Context, ids: IntArray) {
    private val tones = intArrayOf(0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100)
    private val colors = ids.map { Color(context.getColor(it)) }
    operator fun get(tone: Int): Color {
        val high = tones.indexOfFirst { it >= tone }
        if (tones[high] == tone) return colors[high]
        val low = high - 1
        return lerp(colors[low], colors[high], (tone - tones[low]).toFloat() / (tones[high] - tones[low]))
    }
}
