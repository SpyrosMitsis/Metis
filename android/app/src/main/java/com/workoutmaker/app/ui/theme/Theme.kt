package com.workoutmaker.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import com.workoutmaker.app.data.ThemePalette
import androidx.annotation.RequiresApi

// Android 12+ only; the picker hides/falls back to Serene Vanguard below that.
val dynamicColorSupported: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

// ============================================================================
// "Serene Vanguard" — grounded, restorative wellness palette.
// Sage Green accents on a deep charcoal base; depth is tonal, not shadowed.
// ============================================================================

// Brand
val Sage = Color(0xFFB6CCB6)        // primary accent
val Sand = Color(0xFFD3C4B3)        // secondary (warm sand)
val Moss = Color(0xFF5E6D5F)        // subtle distinctions

// Semantic readiness bands (kept calm, per design — no emergency reds unless needed)
val BandGreen = Color(0xFFB6CCB6)
val BandAmber = Color(0xFFE5C07B)
val BandRed = Color(0xFFFFB4AB)
val Red = BandRed

// Surfaces (tonal elevation: lighter = higher)
private val Base = Color(0xFF121414)
private val SurfaceCard = Color(0xFF1E2020)
private val SurfaceHigh = Color(0xFF282A2A)
private val SurfaceVariant = Color(0xFF333535)

private val DarkColors = darkColorScheme(
    primary = Sage,
    onPrimary = Color(0xFF223525),
    primaryContainer = Color(0xFF384B3A),
    onPrimaryContainer = Color(0xFFD1E9D1),
    secondary = Sand,
    onSecondary = Color(0xFF382F23),
    secondaryContainer = Color(0xFF51483A),
    onSecondaryContainer = Color(0xFFC4B6A5),
    tertiary = Color(0xFFBBCBBA),
    onTertiary = Color(0xFF263428),
    background = Base,
    onBackground = Color(0xFFE2E2E2),
    surface = SurfaceCard,
    onSurface = Color(0xFFE2E2E2),
    surfaceVariant = SurfaceVariant,
    onSurfaceVariant = Color(0xFFC3C8C0),
    surfaceContainerLowest = Color(0xFF0D0F0F),
    surfaceContainerLow = Color(0xFF1A1C1C),
    surfaceContainer = SurfaceCard,
    surfaceContainerHigh = SurfaceHigh,
    surfaceContainerHighest = Color(0xFF333535),
    outline = Color(0xFF8D928B),
    outlineVariant = Color(0xFF434842),
    error = BandRed,
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
)

// Light "Serene Vanguard": the same sage identity on warm sage-tinted paper.
// Depth is tonal (cards lift lighter off the page; inset rows recess darker),
// mirroring the dark theme's logic rather than relying on shadows. The accent is
// a DEEPER sage than the dark-mode pastel so it stays legible on a light surface.
private val LightColors = lightColorScheme(
    primary = Color(0xFF40624A),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFC2E8C7),
    onPrimaryContainer = Color(0xFF00210D),
    secondary = Color(0xFF6A5D4E),          // warm taupe — the light-mode "Sand"
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFF2E3CE),
    onSecondaryContainer = Color(0xFF241A0C),
    tertiary = Color(0xFF4A635A),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFCCE9DC),
    onTertiaryContainer = Color(0xFF06201A),
    background = Color(0xFFF1F4EC),          // soft sage paper
    onBackground = Color(0xFF1A1C19),
    surface = Color(0xFFFAFCF4),             // card — lifts lighter off the paper
    onSurface = Color(0xFF1A1C19),
    surfaceVariant = Color(0xFFDDE5D8),
    onSurfaceVariant = Color(0xFF424A40),
    // Lowest is intentionally DARKER than the card so inset stats/quote blocks
    // read as recessed (same trick as the dark theme, inverted).
    surfaceContainerLowest = Color(0xFFE7ECE0),
    surfaceContainerLow = Color(0xFFF3F6EC),
    surfaceContainer = Color(0xFFFAFCF4),
    surfaceContainerHigh = Color(0xFFEFF2E8),
    surfaceContainerHighest = Color(0xFFE9EDE2),
    outline = Color(0xFF72796D),
    outlineVariant = Color(0xFFC2C9BB),
    // Soft band-red, matching every other scheme. colorScheme.error doubles as the
    // "needs attention" band (low adherence, deep fatigue, hard RPE), so a true
    // alarm red made light mode read as an emergency — calm bands, no emergency reds.
    error = BandRed,
    onError = Color(0xFF690005),
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
)

// ============================================================================
// Swappable palettes. Most of the UI is driven by MaterialTheme.colorScheme, so a
// palette is mainly a dark+light ColorScheme pair plus the two accents that have
// no colorScheme slot (amber = caution, moss = subtle distinction). Add a palette
// here + an entry in ThemePalette and it becomes selectable in Settings.
// ============================================================================

// Accents not covered by ColorScheme. Read via amberAccent()/mossAccent().
data class AppAccents(val amber: Color, val moss: Color)

data class AppPalette(
    val dark: ColorScheme,
    val light: ColorScheme,
    val darkAccents: AppAccents,
    val lightAccents: AppAccents,
)

// Palette #1 — the locked baseline. Exactly today's Serene Vanguard values
// (incl. the previous amberAccent light tone), so the default look is unchanged.
val SereneVanguard = AppPalette(
    dark = DarkColors,
    light = LightColors,
    darkAccents = AppAccents(amber = BandAmber, moss = Moss),
    lightAccents = AppAccents(amber = Color(0xFF8A5A12), moss = Moss),
)

// Palette #2 — "Ember": warm clay/terracotta on warm charcoal / warm paper.
private val EmberDark = darkColorScheme(
    primary = Color(0xFFE8A87C), onPrimary = Color(0xFF4A2410),
    primaryContainer = Color(0xFF5A3A26), onPrimaryContainer = Color(0xFFFFD9C2),
    secondary = Color(0xFFD9B48A), onSecondary = Color(0xFF3A2A14),
    secondaryContainer = Color(0xFF4E3A22), onSecondaryContainer = Color(0xFFF0D9BC),
    tertiary = Color(0xFFC9B79C), onTertiary = Color(0xFF33271A),
    background = Color(0xFF16110E), onBackground = Color(0xFFECE2DA),
    surface = Color(0xFF221B16), onSurface = Color(0xFFECE2DA),
    surfaceVariant = Color(0xFF3A302A), onSurfaceVariant = Color(0xFFD2C4B8),
    surfaceContainerLowest = Color(0xFF100B08), surfaceContainerLow = Color(0xFF1C1611),
    surfaceContainer = Color(0xFF221B16), surfaceContainerHigh = Color(0xFF2C241E),
    surfaceContainerHighest = Color(0xFF372D26),
    outline = Color(0xFF998A7E), outlineVariant = Color(0xFF4A3F38),
    error = BandRed, onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)
private val EmberLight = lightColorScheme(
    primary = Color(0xFF9A4A1E), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFDBC9), onPrimaryContainer = Color(0xFF360F00),
    secondary = Color(0xFF7A5A36), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFF8DEC0), onSecondaryContainer = Color(0xFF2A1800),
    tertiary = Color(0xFF6A5D4A), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFF3E3CE), onTertiaryContainer = Color(0xFF241A0C),
    background = Color(0xFFFBF2EA), onBackground = Color(0xFF231A14),
    surface = Color(0xFFFFF8F2), onSurface = Color(0xFF231A14),
    surfaceVariant = Color(0xFFEBDDD0), onSurfaceVariant = Color(0xFF4E4339),
    surfaceContainerLowest = Color(0xFFEFE2D6), surfaceContainerLow = Color(0xFFFBEFE4),
    surfaceContainer = Color(0xFFFFF8F2), surfaceContainerHigh = Color(0xFFF6EADE),
    surfaceContainerHighest = Color(0xFFF0E4D7),
    outline = Color(0xFF80776C), outlineVariant = Color(0xFFCFC3B6),
    error = Color(0xFFB3261E), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF9DEDC), onErrorContainer = Color(0xFF410E0B),
)
val Ember = AppPalette(
    dark = EmberDark, light = EmberLight,
    darkAccents = AppAccents(amber = Color(0xFFE5B26A), moss = Color(0xFF8A6E5A)),
    lightAccents = AppAccents(amber = Color(0xFF9A6B17), moss = Color(0xFF7A5A40)),
)

// Palette #3 — "Tidal": cool teal/aqua on cool charcoal / cool paper.
private val TidalDark = darkColorScheme(
    primary = Color(0xFF6FD3C2), onPrimary = Color(0xFF00382F),
    primaryContainer = Color(0xFF1E4A45), onPrimaryContainer = Color(0xFFB8ECE3),
    secondary = Color(0xFF9CC5D9), onSecondary = Color(0xFF10323F),
    secondaryContainer = Color(0xFF274857), onSecondaryContainer = Color(0xFFC3E3F2),
    tertiary = Color(0xFFAEC2D6), onTertiary = Color(0xFF1B2C39),
    background = Color(0xFF0F1416), onBackground = Color(0xFFDCE4E5),
    surface = Color(0xFF192023), onSurface = Color(0xFFDCE4E5),
    surfaceVariant = Color(0xFF2C3539), onSurfaceVariant = Color(0xFFBFCBCE),
    surfaceContainerLowest = Color(0xFF0A0F11), surfaceContainerLow = Color(0xFF151B1D),
    surfaceContainer = Color(0xFF192023), surfaceContainerHigh = Color(0xFF232B2E),
    surfaceContainerHighest = Color(0xFF2D3639),
    outline = Color(0xFF869397), outlineVariant = Color(0xFF3E484B),
    error = BandRed, onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)
private val TidalLight = lightColorScheme(
    primary = Color(0xFF1F6F66), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFA8F0E4), onPrimaryContainer = Color(0xFF00201C),
    secondary = Color(0xFF3F6478), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFCDE7F6), onSecondaryContainer = Color(0xFF001E2C),
    tertiary = Color(0xFF4A6070), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD2E4F2), onTertiaryContainer = Color(0xFF06202C),
    background = Color(0xFFEDF4F3), onBackground = Color(0xFF161D1E),
    surface = Color(0xFFF6FBFA), onSurface = Color(0xFF161D1E),
    surfaceVariant = Color(0xFFD6E1E0), onSurfaceVariant = Color(0xFF3E4948),
    surfaceContainerLowest = Color(0xFFE1ECEA), surfaceContainerLow = Color(0xFFEFF6F5),
    surfaceContainer = Color(0xFFF6FBFA), surfaceContainerHigh = Color(0xFFEAF2F1),
    surfaceContainerHighest = Color(0xFFE4ECEB),
    outline = Color(0xFF6F7A79), outlineVariant = Color(0xFFBEC9C7),
    error = Color(0xFFB3261E), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF9DEDC), onErrorContainer = Color(0xFF410E0B),
)
val Tidal = AppPalette(
    dark = TidalDark, light = TidalLight,
    darkAccents = AppAccents(amber = BandAmber, moss = Color(0xFF5E8A86)),
    lightAccents = AppAccents(amber = Color(0xFF8A5A12), moss = Color(0xFF3E6B66)),
)

// Palette #4 — "Nocturne": cool indigo/violet on a deep blue-charcoal / cool paper.
private val NocturneDark = darkColorScheme(
    primary = Color(0xFFB0B8F5), onPrimary = Color(0xFF1E2456),
    primaryContainer = Color(0xFF353C70), onPrimaryContainer = Color(0xFFDDE1FF),
    secondary = Color(0xFFC2B4E0), onSecondary = Color(0xFF2E2447),
    secondaryContainer = Color(0xFF453A5E), onSecondaryContainer = Color(0xFFE5DAFE),
    tertiary = Color(0xFFAEC0DE), onTertiary = Color(0xFF1B2B40),
    background = Color(0xFF101218), onBackground = Color(0xFFE1E2EA),
    surface = Color(0xFF1A1D26), onSurface = Color(0xFFE1E2EA),
    surfaceVariant = Color(0xFF2E313D), onSurfaceVariant = Color(0xFFC4C6D4),
    surfaceContainerLowest = Color(0xFF0B0D12), surfaceContainerLow = Color(0xFF161822),
    surfaceContainer = Color(0xFF1A1D26), surfaceContainerHigh = Color(0xFF242732),
    surfaceContainerHighest = Color(0xFF2E323E),
    outline = Color(0xFF8C8FA0), outlineVariant = Color(0xFF40434F),
    error = BandRed, onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)
private val NocturneLight = lightColorScheme(
    primary = Color(0xFF42499A), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFDFE1FF), onPrimaryContainer = Color(0xFF000B5C),
    secondary = Color(0xFF5C5478), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFE5DDFF), onSecondaryContainer = Color(0xFF191033),
    tertiary = Color(0xFF44566F), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD6E3FB), onTertiaryContainer = Color(0xFF001129),
    background = Color(0xFFF1F1F8), onBackground = Color(0xFF1A1B22),
    surface = Color(0xFFF9F9FF), onSurface = Color(0xFF1A1B22),
    surfaceVariant = Color(0xFFDEDFEC), onSurfaceVariant = Color(0xFF45464F),
    surfaceContainerLowest = Color(0xFFE6E6F2), surfaceContainerLow = Color(0xFFF2F2FB),
    surfaceContainer = Color(0xFFF9F9FF), surfaceContainerHigh = Color(0xFFECECF6),
    surfaceContainerHighest = Color(0xFFE6E6F0),
    outline = Color(0xFF757680), outlineVariant = Color(0xFFC5C6D2),
    error = Color(0xFFB3261E), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF9DEDC), onErrorContainer = Color(0xFF410E0B),
)
val Nocturne = AppPalette(
    dark = NocturneDark, light = NocturneLight,
    darkAccents = AppAccents(amber = BandAmber, moss = Color(0xFF6E72A0)),
    lightAccents = AppAccents(amber = Color(0xFF8A5A12), moss = Color(0xFF4E5280)),
)

// Palette #5 — "Bloom": warm rose/magenta on warm-plum charcoal / blush paper.
private val BloomDark = darkColorScheme(
    primary = Color(0xFFF0A8C0), onPrimary = Color(0xFF50132C),
    primaryContainer = Color(0xFF6A2942), onPrimaryContainer = Color(0xFFFFD9E3),
    secondary = Color(0xFFE0B0C8), onSecondary = Color(0xFF42233A),
    secondaryContainer = Color(0xFF5A3850), onSecondaryContainer = Color(0xFFFAD9EC),
    tertiary = Color(0xFFD9B49C), onTertiary = Color(0xFF402718),
    background = Color(0xFF171013), onBackground = Color(0xFFEBE0E3),
    surface = Color(0xFF221A1D), onSurface = Color(0xFFEBE0E3),
    surfaceVariant = Color(0xFF3A2E33), onSurfaceVariant = Color(0xFFD4C2C8),
    surfaceContainerLowest = Color(0xFF110B0E), surfaceContainerLow = Color(0xFF1C1518),
    surfaceContainer = Color(0xFF221A1D), surfaceContainerHigh = Color(0xFF2D2327),
    surfaceContainerHighest = Color(0xFF382C31),
    outline = Color(0xFF9C8B91), outlineVariant = Color(0xFF4C3E43),
    error = BandRed, onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)
private val BloomLight = lightColorScheme(
    primary = Color(0xFF9C2F55), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFD9E2), onPrimaryContainer = Color(0xFF3E0017),
    secondary = Color(0xFF74566A), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFFCD8EC), onSecondaryContainer = Color(0xFF2B1525),
    tertiary = Color(0xFF7A5847), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFFFDBC8), onTertiaryContainer = Color(0xFF2D1608),
    background = Color(0xFFFCF1F3), onBackground = Color(0xFF221A1C),
    surface = Color(0xFFFFF8F8), onSurface = Color(0xFF221A1C),
    surfaceVariant = Color(0xFFEDDDE2), onSurfaceVariant = Color(0xFF504247),
    surfaceContainerLowest = Color(0xFFF1E2E6), surfaceContainerLow = Color(0xFFFCEFF1),
    surfaceContainer = Color(0xFFFFF8F8), surfaceContainerHigh = Color(0xFFF7E9EC),
    surfaceContainerHighest = Color(0xFFF1E3E7),
    outline = Color(0xFF837377), outlineVariant = Color(0xFFD5C2C8),
    error = Color(0xFFB3261E), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF9DEDC), onErrorContainer = Color(0xFF410E0B),
)
val Bloom = AppPalette(
    dark = BloomDark, light = BloomLight,
    darkAccents = AppAccents(amber = BandAmber, moss = Color(0xFF9A6E84)),
    lightAccents = AppAccents(amber = Color(0xFF8A5A12), moss = Color(0xFF7A506A)),
)

// Palette #6 — "Solstice": warm gold/amber on a near-neutral graphite / cream paper.
private val SolsticeDark = darkColorScheme(
    primary = Color(0xFFE8C36A), onPrimary = Color(0xFF3D2E00),
    primaryContainer = Color(0xFF564300), onPrimaryContainer = Color(0xFFFFE08A),
    secondary = Color(0xFFD6C6A0), onSecondary = Color(0xFF38301A),
    secondaryContainer = Color(0xFF4F462E), onSecondaryContainer = Color(0xFFF3E2BB),
    tertiary = Color(0xFFB6C9A6), onTertiary = Color(0xFF223219),
    background = Color(0xFF14130F), onBackground = Color(0xFFE6E2D7),
    surface = Color(0xFF1F1D18), onSurface = Color(0xFFE6E2D7),
    surfaceVariant = Color(0xFF38352B), onSurfaceVariant = Color(0xFFCDC7B6),
    surfaceContainerLowest = Color(0xFF0E0D09), surfaceContainerLow = Color(0xFF1A1813),
    surfaceContainer = Color(0xFF1F1D18), surfaceContainerHigh = Color(0xFF2A2721),
    surfaceContainerHighest = Color(0xFF34312A),
    outline = Color(0xFF978F7C), outlineVariant = Color(0xFF49463A),
    error = BandRed, onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)
private val SolsticeLight = lightColorScheme(
    primary = Color(0xFF7A5A00), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFE08A), onPrimaryContainer = Color(0xFF261A00),
    secondary = Color(0xFF6B5D3E), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFF4E2BA), onSecondaryContainer = Color(0xFF231A04),
    tertiary = Color(0xFF52643F), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD4EABB), onTertiaryContainer = Color(0xFF112004),
    background = Color(0xFFF7F3E8), onBackground = Color(0xFF1C1B14),
    surface = Color(0xFFFDFAF0), onSurface = Color(0xFF1C1B14),
    surfaceVariant = Color(0xFFE8E1CD), onSurfaceVariant = Color(0xFF4A4639),
    surfaceContainerLowest = Color(0xFFEDE8D9), surfaceContainerLow = Color(0xFFF8F3E5),
    surfaceContainer = Color(0xFFFDFAF0), surfaceContainerHigh = Color(0xFFF1ECDD),
    surfaceContainerHighest = Color(0xFFEBE6D7),
    outline = Color(0xFF7C7765), outlineVariant = Color(0xFFCDC6B1),
    error = Color(0xFFB3261E), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF9DEDC), onErrorContainer = Color(0xFF410E0B),
)
val Solstice = AppPalette(
    dark = SolsticeDark, light = SolsticeLight,
    darkAccents = AppAccents(amber = Color(0xFFE8C36A), moss = Color(0xFF8A8466)),
    lightAccents = AppAccents(amber = Color(0xFF8A5A12), moss = Color(0xFF6B6648)),
)

// Android's dynamic scheme uses a different surface convention than every palette
// above: it makes `surface` EQUAL to `background`, and in light mode it runs the
// container ramp downwards from white (lowest = white, highest = darkest). This
// app reads `surface` as "the card" and `surfaceContainerLowest` as "the recessed
// block inside the card", so a raw dynamic scheme loses the card lift entirely and
// inverts the insets. Re-point the surface roles at the dynamic tones that already
// carry the right relationship, so Material You gets the same depth as the rest.
private fun ColorScheme.withCardSurfaces(darkTheme: Boolean): ColorScheme =
    if (darkTheme) {
        // Dark already ramps upwards (lowest < background < low < container < …);
        // only the card itself is wrong, sitting flat on the background.
        copy(surface = surfaceContainer)
    } else {
        copy(
            // Lightest tone (white) becomes the card, lifting it off the paper.
            surface = surfaceContainerLowest,
            surfaceContainer = surfaceContainerLowest,
            // …and the rest of the ramp shifts down one step so insets recess.
            surfaceContainerHigh = surfaceContainer,
            surfaceContainerHighest = surfaceContainerHigh,
            surfaceContainerLowest = surfaceContainerHighest,
        )
    }

// The picker's swatches show the same colours the app will actually render.
@RequiresApi(Build.VERSION_CODES.S)
internal fun dynamicScheme(
    context: android.content.Context,
    darkTheme: Boolean,
): ColorScheme =
    (if (Build.VERSION.SDK_INT >= 34 && Build.MANUFACTURER.equals("samsung", ignoreCase = true)) {
        systemPaletteScheme(context, darkTheme)
    } else if (darkTheme) {
        dynamicDarkColorScheme(context)
    } else {
        dynamicLightColorScheme(context)
    }).withCardSurfaces(darkTheme)

// Map the persisted palette choice (a pure-data enum in AppPreferences) → colors.
fun ThemePalette.palette(): AppPalette = when (this) {
    ThemePalette.SERENE -> SereneVanguard
    ThemePalette.EMBER -> Ember
    ThemePalette.TIDAL -> Tidal
    ThemePalette.NOCTURNE -> Nocturne
    ThemePalette.BLOOM -> Bloom
    ThemePalette.SOLSTICE -> Solstice
    // Real colours for DYNAMIC come from dynamicDark/LightColorScheme(context) in
    // WorkoutMakerTheme, which needs a Context this pure mapping doesn't have.
    // This is only a fallback for previews on API < 31.
    ThemePalette.DYNAMIC -> SereneVanguard
}

// Active accents for the current palette+mode, provided by WorkoutMakerTheme.
val LocalAppAccents = staticCompositionLocalOf { SereneVanguard.darkAccents }

// Caution/amber accent (no ColorScheme slot). Follows the active palette + mode.
@Composable
fun amberAccent(): Color = LocalAppAccents.current.amber

// Muted "subtle distinction" accent (chips, chart lines). Follows the palette.
@Composable
fun mossAccent(): Color = LocalAppAccents.current.moss

@Composable
fun WorkoutMakerTheme(
    themePalette: ThemePalette = ThemePalette.SERENE,
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val useDynamic = themePalette == ThemePalette.DYNAMIC && dynamicColorSupported
    val context = LocalContext.current
    val palette = themePalette.palette()
    val colorScheme = when {
        useDynamic -> dynamicScheme(context, darkTheme)
        darkTheme -> palette.dark
        else -> palette.light
    }
    // Amber/moss have no ColorScheme slot. Dynamic mode keeps the steady amber
    // (still a caution colour, shouldn't shift with wallpaper) but ties moss to
    // the device's own secondary so "subtle distinction" chips stay on-brand.
    val accents = if (useDynamic) {
        val base = if (darkTheme) SereneVanguard.darkAccents else SereneVanguard.lightAccents
        base.copy(moss = colorScheme.secondary)
    } else if (darkTheme) palette.darkAccents else palette.lightAccents
    MaterialTheme(colorScheme = colorScheme, typography = AppTypography) {
        CompositionLocalProvider(LocalAppAccents provides accents, content = content)
    }
}
