package com.workoutmaker.app.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import com.workoutmaker.app.ui.screens.home.HomeLayout
import com.workoutmaker.app.ui.screens.settings.SetupNudge
import com.workoutmaker.app.ui.screens.home.homeLayoutFrom
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.roundToInt
import androidx.datastore.preferences.core.MutablePreferences

// Device-local app preferences (not tied to the cloud profile). These are the
// "how the app behaves on this phone" knobs that used to be hardcoded or live
// scattered in screens; the holistic Settings panel now edits them in one place.

enum class ThemeMode(val label: String) {
    SYSTEM("Follow system"), DARK("Dark"), LIGHT("Light");

    companion object {
        fun fromName(n: String?): ThemeMode = entries.firstOrNull { it.name == n } ?: SYSTEM
    }
}

// Selectable colour palette (the actual colours live in ui/theme/Theme.kt; this
// is just the persisted choice). SERENE is the locked baseline; DYNAMIC leads the
// list and is the default, so a fresh install already looks like the phone it is
// on. The choice persists by NAME, so this order is free to change.
enum class ThemePalette(val label: String) {
    // Pulled live from the device wallpaper (Android 12+ dynamic color / "Material You").
    // Falls back to Serene on older Android versions.
    DYNAMIC("Material You"),
    SERENE("Serene"), EMBER("Ember"), TIDAL("Tidal"),
    NOCTURNE("Nocturne"), BLOOM("Bloom"), SOLSTICE("Solstice");

    companion object {
        fun fromName(n: String?): ThemePalette = entries.firstOrNull { it.name == n } ?: DYNAMIC
    }
}

// Sound played when a rest timer finishes while the app is open. (The
// background alarm keeps the notification channel's system sound.)
enum class RestChime(val label: String) {
    SYSTEM("System default"), CHIME("Chime"), BEEP("Beep"), DOUBLE_BEEP("Double beep"), SILENT("Silent");

    companion object {
        fun fromName(n: String?): RestChime = entries.firstOrNull { it.name == n } ?: SYSTEM
    }
}

enum class WeightUnit(val label: String, val suffix: String) {
    KG("Kilograms", "kg"),
    LB("Pounds", "lb");

    companion object {
        private const val LB_PER_KG = 2.2046226218
        fun fromName(n: String?): WeightUnit = entries.firstOrNull { it.name == n } ?: KG
        fun kgToDisplay(kg: Double, unit: WeightUnit) = if (unit == LB) kg * LB_PER_KG else kg
        fun displayToKg(v: Double, unit: WeightUnit) = if (unit == LB) v / LB_PER_KG else v
    }
}

data class AppSettings(
    val units: WeightUnit = WeightUnit.KG,
    val defaultRestSec: Int = 120,
    val barbellKg: Double = 20.0,
    val restVibrate: Boolean = true,
    val restNotify: Boolean = true,
    val restChime: RestChime = RestChime.SYSTEM,
    val keepScreenOn: Boolean = true,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val themePalette: ThemePalette = ThemePalette.DYNAMIC,
    // Soft monthly AI-spend cap (USD). 0 = no cap; Diagnostics warns when 30-day
    // estimated spend crosses it.
    val spendCapUsd: Double = 0.0,
    // Morning readiness notification (score + day summary at wake-up).
    val morningNotify: Boolean = true,
    // Device-calendar integration (both opt-in, both also need the runtime
    // permission): read busy times into planning / write workouts as all-day events.
    val calendarRead: Boolean = false,
    val calendarWrite: Boolean = false,
    // Debug logs are always kept locally (for export). Off by default: the log
    // file only ever leaves the phone if the athlete opts into sending it.
    val debugLogSharingEnabled: Boolean = false,
)

private val Context.dataStore by preferencesDataStore(name = "app_prefs")

@Singleton
class AppPreferences @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private object Keys {
        val units = stringPreferencesKey("units")
        val defaultRest = intPreferencesKey("default_rest_sec")
        val barbell = doublePreferencesKey("barbell_kg")
        val restVibrate = booleanPreferencesKey("rest_vibrate")
        val restNotify = booleanPreferencesKey("rest_notify")
        val restChime = stringPreferencesKey("rest_chime")
        val keepScreenOn = booleanPreferencesKey("keep_screen_on")
        val themeMode = stringPreferencesKey("theme_mode")
        val themePalette = stringPreferencesKey("theme_palette")
        val featureTourPending = booleanPreferencesKey("feature_tour_pending")
        val onboardingComplete = booleanPreferencesKey("onboarding_complete")
        val customsCleanupV1 = booleanPreferencesKey("customs_cleanup_v1")
        val spendCap = doublePreferencesKey("spend_cap_usd")
        val lastAccountUid = stringPreferencesKey("last_account_uid")
        val morningNotify = booleanPreferencesKey("morning_notify")
        val setupNudgeDismissedAt = longPreferencesKey("setup_nudge_dismissed_at")
        val calendarRead = booleanPreferencesKey("calendar_read")
        val calendarWrite = booleanPreferencesKey("calendar_write")
        val debugLogSharing = booleanPreferencesKey("debug_log_sharing_enabled")
        // Home layout: the athlete's own card order, and what they switched off.
        // Two CSVs of card keys rather than a serialized object, so an unknown
        // key from a future or past release is skipped instead of failing to parse.
        val homeOrder = stringPreferencesKey("home_card_order")
        val homeHidden = stringPreferencesKey("home_cards_hidden")
        // Month or week on the calendar. A view preference, not a navigation
        // state: an athlete who only ever wants the week should get the week
        // on every cold start, not just until the process dies.
        val calendarWeekView = booleanPreferencesKey("calendar_week_view")
        // Performance numbers the athlete has told us not to ask about again.
        // CSV of the same names missingNumbers() produces, for the same reason
        // the Home layout is a CSV: an unknown name is skipped, never a crash.
        val hushedNumbers = stringPreferencesKey("hushed_numbers")
        // The "Finish setup" card at the top of Settings: how many times it has
        // been closed, and when the last one was. Three closes a week apart and
        // it stops asking, see setupCardVisible().
        val setupCardDismissals = intPreferencesKey("setup_card_dismissals")
        val setupCardDismissedAt = longPreferencesKey("setup_card_dismissed_at")
        // Superseded by the pair above. Read once so an athlete who already
        // closed the card under the previous build is not asked again the same
        // day, then never written.
        val setupCardDismissed = booleanPreferencesKey("setup_card_dismissed")
    }

    /** Times the Settings "Finish setup" card has been closed, and when. */
    val setupNudge: Flow<SetupNudge> = context.dataStore.data.map { p ->
        val legacy = p[Keys.setupCardDismissed] == true
        SetupNudge(
            dismissals = p[Keys.setupCardDismissals] ?: (if (legacy) 1 else 0),
            lastDismissedAt = p[Keys.setupCardDismissedAt] ?: (if (legacy) System.currentTimeMillis() else 0L),
        )
    }

    suspend fun dismissSetupCard() = edit { p ->
        p[Keys.setupCardDismissals] = (p[Keys.setupCardDismissals] ?: (if (p[Keys.setupCardDismissed] == true) 1 else 0)) + 1
        p[Keys.setupCardDismissedAt] = System.currentTimeMillis()
    }

    // Local presentation state, isolated by signed-in account; never deletes sets.
    suspend fun hiddenExerciseStats(owner: String): Set<String> =
        context.dataStore.data.firstOrNull()?.get(stringSetPreferencesKey("hidden_exercise_stats_$owner")) ?: emptySet()

    suspend fun setExerciseStatsHidden(owner: String, name: String, hidden: Boolean) {
        require(owner.isNotBlank())
        val key = stringSetPreferencesKey("hidden_exercise_stats_$owner")
        context.dataStore.edit { p -> p[key] = if (hidden) p[key].orEmpty() + name else p[key].orEmpty() - name }
    }

    val calendarWeekView: Flow<Boolean> =
        context.dataStore.data.map { it[Keys.calendarWeekView] ?: false }

    suspend fun setCalendarWeekView(on: Boolean) = edit { it[Keys.calendarWeekView] = on }

    /**
     * Missing numbers the athlete has hushed. A number they do not have is not
     * an unfinished setup step: someone who rides once a month has no FTP and
     * never will, and an amber row that cannot be resolved is just a scold.
     */
    val hushedNumbers: Flow<Set<String>> = context.dataStore.data.map { p ->
        p[Keys.hushedNumbers].orEmpty().split(",").map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    }

    suspend fun setNumberHushed(name: String, hushed: Boolean) = edit { p ->
        val current = p[Keys.hushedNumbers].orEmpty().split(",").map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        p[Keys.hushedNumbers] = (if (hushed) current + name else current - name).joinToString(",")
    }

    /** The athlete's Home layout, or the default when they have never touched it. */
    val homeLayout: Flow<HomeLayout> = context.dataStore.data.map { p ->
        homeLayoutFrom(p[Keys.homeOrder], p[Keys.homeHidden])
    }

    suspend fun setHomeLayout(layout: HomeLayout) = edit {
        it[Keys.homeOrder] = layout.orderCsv
        it[Keys.homeHidden] = layout.hiddenCsv
    }

    // The Home "finish setting up your coach" card for onboarding skippers.
    // Dismissal snoozes it 14 days (it re-appears only while the profile is
    // still empty), so it nudges without nagging.
    suspend fun setupNudgeDismissedAt(): Long? =
        context.dataStore.data.firstOrNull()?.get(Keys.setupNudgeDismissedAt)

    suspend fun dismissSetupNudge() = edit { it[Keys.setupNudgeDismissedAt] = System.currentTimeMillis() }

    // The user id that this device's local data (Room strength tables, caches,
    // onboarding flag) belongs to. Compared on every sign-in so a different
    // account never sees or syncs the previous account's local rows.
    suspend fun lastAccountUid(): String? =
        context.dataStore.data.firstOrNull()?.get(Keys.lastAccountUid)

    suspend fun setLastAccountUid(uid: String) = edit { it[Keys.lastAccountUid] = uid }

    // One-time migration guard: collapse reworded custom exercises onto their
    // bundled-catalog twin (e.g. "Machine Lat Pulldown" → "Lat Pulldown").
    suspend fun customsCleanupV1Done(): Boolean =
        context.dataStore.data.firstOrNull()?.get(Keys.customsCleanupV1) ?: false
    suspend fun setCustomsCleanupV1Done() = edit { it[Keys.customsCleanupV1] = true }

    // Last KNOWN onboarding state — consulted only when the network check fails,
    // so an offline cold start doesn't dump an onboarded user back into the
    // welcome flow. Reset on sign-out.
    val featureTourPending: Flow<Boolean> = context.dataStore.data.map { it[Keys.featureTourPending] ?: false }
    suspend fun setFeatureTourPending(pending: Boolean) = edit { it[Keys.featureTourPending] = pending }

    suspend fun onboardingCompleteCached(): Boolean =
        context.dataStore.data.firstOrNull()?.get(Keys.onboardingComplete) ?: false

    suspend fun setOnboardingComplete(v: Boolean) = edit { it[Keys.onboardingComplete] = v }

    val settings: Flow<AppSettings> = context.dataStore.data.map { p ->
        AppSettings(
            units = WeightUnit.fromName(p[Keys.units]),
            defaultRestSec = p[Keys.defaultRest] ?: 120,
            barbellKg = p[Keys.barbell] ?: 20.0,
            restVibrate = p[Keys.restVibrate] ?: true,
            restNotify = p[Keys.restNotify] ?: true,
            restChime = RestChime.fromName(p[Keys.restChime]),
            keepScreenOn = p[Keys.keepScreenOn] ?: true,
            themeMode = ThemeMode.fromName(p[Keys.themeMode]),
            themePalette = ThemePalette.fromName(p[Keys.themePalette]),
            spendCapUsd = p[Keys.spendCap] ?: 0.0,
            morningNotify = p[Keys.morningNotify] ?: true,
            calendarRead = p[Keys.calendarRead] ?: false,
            calendarWrite = p[Keys.calendarWrite] ?: false,
            debugLogSharingEnabled = p[Keys.debugLogSharing] ?: false,
        )
    }

    suspend fun setUnits(u: WeightUnit) = edit { it[Keys.units] = u.name }
    suspend fun setDefaultRest(sec: Int) = edit { it[Keys.defaultRest] = sec.coerceIn(0, 600) }
    suspend fun setBarbell(kg: Double) = edit { it[Keys.barbell] = kg.coerceIn(0.0, 50.0) }
    suspend fun setRestVibrate(on: Boolean) = edit { it[Keys.restVibrate] = on }
    suspend fun setRestNotify(on: Boolean) = edit { it[Keys.restNotify] = on }
    suspend fun setRestChime(c: RestChime) = edit { it[Keys.restChime] = c.name }
    suspend fun setKeepScreenOn(on: Boolean) = edit { it[Keys.keepScreenOn] = on }
    suspend fun setThemeMode(m: ThemeMode) = edit { it[Keys.themeMode] = m.name }
    suspend fun setThemePalette(p: ThemePalette) = edit { it[Keys.themePalette] = p.name }
    suspend fun setSpendCap(usd: Double) = edit { it[Keys.spendCap] = usd.coerceIn(0.0, 1000.0) }
    suspend fun setMorningNotify(on: Boolean) = edit { it[Keys.morningNotify] = on }
    suspend fun setCalendarRead(on: Boolean) = edit { it[Keys.calendarRead] = on }
    suspend fun setCalendarWrite(on: Boolean) = edit { it[Keys.calendarWrite] = on }
    suspend fun setDebugLogSharing(on: Boolean) = edit { it[Keys.debugLogSharing] = on }

    private suspend fun edit(block: (MutablePreferences) -> Unit) {
        context.dataStore.edit(block)
    }
}

// Round a kg value to a clean display number for the active unit.
fun WeightUnit.format(kg: Double): String {
    val v = WeightUnit.kgToDisplay(kg, this)
    return if (kotlin.math.abs(v - v.roundToInt()) < 0.05) v.roundToInt().toString()
    else ((v * 10).roundToInt() / 10.0).toString()
}
