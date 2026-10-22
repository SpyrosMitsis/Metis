package com.workoutmaker.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import io.github.jan.supabase.gotrue.auth
import com.workoutmaker.app.util.runCatching
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.FitnessCenter
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.workoutmaker.app.ui.AuthGate
import com.workoutmaker.app.ui.screens.history.BodyHistoryScreen
import com.workoutmaker.app.ui.screens.calendar.CalendarScreen
import com.workoutmaker.app.ui.screens.coach.CoachScreen
import com.workoutmaker.app.ui.screens.home.CustomizeHomeScreen
import com.workoutmaker.app.ui.screens.home.HomeScreen
import com.workoutmaker.app.ui.screens.history.RecoveryHistoryScreen
import com.workoutmaker.app.ui.screens.settings.SettingsScreen
import com.workoutmaker.app.ui.screens.strength.ExerciseStatsPickerScreen
import com.workoutmaker.app.ui.screens.strength.ExerciseStatsScreen
import com.workoutmaker.app.ui.screens.strength.StrengthScreen
import com.workoutmaker.app.ui.screens.history.WorkoutHistoryScreen
import com.workoutmaker.app.strength.StrengthViewModel
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.AppPreferences
import com.workoutmaker.app.data.ThemeMode
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject
import android.content.Intent
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.workoutmaker.app.billing.BillingGateway
import com.workoutmaker.app.data.AuthDeepLinks
import com.workoutmaker.app.data.NotificationDeepLinks
import com.workoutmaker.app.data.ThemePalette
import com.workoutmaker.app.data.WeatherCheckResult
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.ui.components.AppSnackbar
import com.workoutmaker.app.ui.components.LocalAppSnackbar
import com.workoutmaker.app.ui.screens.auth.SetNewPasswordDialog
import java.io.File
import java.net.URLDecoder
import java.net.URLEncoder
import com.workoutmaker.app.data.planStatus
import com.workoutmaker.app.data.verifyPurchase

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val TABS = listOf(
    Tab("home", "Home", Icons.Filled.Home),
    Tab("coach", "Coach", Icons.AutoMirrored.Filled.Chat),
    Tab("calendar", "Calendar", Icons.Filled.CalendarMonth),
    Tab("strength", "Strength", Icons.Filled.FitnessCenter),
    Tab("settings", "Settings", Icons.Filled.Settings),
)

// Exposes the user's theme choice so the whole UI can react to it live.
@HiltViewModel
class ThemeViewModel @Inject constructor(prefs: AppPreferences) : ViewModel() {
    val themeMode = prefs.settings
        .map { it.themeMode }
        .stateIn(viewModelScope, SharingStarted.Eagerly, ThemeMode.SYSTEM)
    val themePalette = prefs.settings
        .map { it.themePalette }
        // Same default as AppSettings, or the first frame flashes the old palette.
        .stateIn(viewModelScope, SharingStarted.Eagerly, ThemePalette.DYNAMIC)
}

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var billing: BillingGateway
    @Inject lateinit var repo: WorkoutRepository
    @Inject lateinit var supabase: io.github.jan.supabase.SupabaseClient

    // Auth email links (workoutmaker://auth/...) re-enter here; import the
    // session and route recovery links to the set-new-password dialog.
    private fun handleAuthLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "workoutmaker" || data.host != "auth") return
        val fragment = data.fragment ?: ""
        if (fragment.contains("error")) {
            AuthDeepLinks.message.value =
                if (fragment.contains("otp_expired")) {
                    "That link has expired or was already used. If you were confirming your email it's likely already confirmed: just sign in. For a password reset, request a fresh link."
                } else {
                    "That sign-in link didn't work. Try again."
                }
            return
        }
        lifecycleScope.launch {
            runCatching { repo.importAuthLink(data) }
                .onSuccess { recovery -> if (recovery) AuthDeepLinks.recoveryPending.value = true }
                .onFailure { AuthDeepLinks.message.value = "That sign-in link could not be opened. Please try again." }
        }
    }

    // Notification taps carry "open this activity" extras (evening debrief).
    // Surface them through NotificationDeepLinks; HomeViewModel resolves them.
    private fun handleNotificationLink(intent: Intent?) {
        val id = intent?.getStringExtra("open_activity_id")
        if (id != null) {
            val date = intent.getStringExtra("open_activity_date")
            if (date != null) {
                NotificationDeepLinks.openActivity.value = id to date
                // Consume so a config change doesn't re-open the overlay.
                intent.removeExtra("open_activity_id")
                intent.removeExtra("open_activity_date")
            }
        }

        // Morning notification's weather line, when today's outdoor session
        // was flagged unviable. Same one-shot extras pattern as above.
        val workoutId = intent?.getStringExtra("open_weather_workout_id")
        if (workoutId != null) {
            NotificationDeepLinks.openWeatherPrompt.value = WeatherCheckResult(
                should_prompt = true,
                sport = intent.getStringExtra("open_weather_sport"),
                reason = intent.getStringExtra("open_weather_reason"),
                workout_id = workoutId,
                swap_type = intent.getStringExtra("open_weather_swap_type"),
            )
            intent.removeExtra("open_weather_workout_id")
            intent.removeExtra("open_weather_sport")
            intent.removeExtra("open_weather_reason")
            intent.removeExtra("open_weather_swap_type")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAuthLink(intent)
        handleNotificationLink(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        handleAuthLink(intent)
        handleNotificationLink(intent)

        // A recovery link's session survives a process kill, but the in-memory
        // recoveryPending flag doesn't — without persistence, kill+relaunch
        // would skip the forced password change. Mirror the flag to disk and
        // re-arm the dialog once the stored session has been restored.
        val authFlags = getSharedPreferences("auth_flags", MODE_PRIVATE)
        lifecycleScope.launch {
            if (authFlags.getBoolean("recovery_pending", false)) {
                val restored = supabase.auth.sessionStatus.first {
                    it is io.github.jan.supabase.gotrue.SessionStatus.Authenticated ||
                        it is io.github.jan.supabase.gotrue.SessionStatus.NotAuthenticated
                }
                if (restored is io.github.jan.supabase.gotrue.SessionStatus.Authenticated) {
                    AuthDeepLinks.recoveryPending.value = true
                }
            }
            AuthDeepLinks.recoveryPending.collect { pending ->
                authFlags.edit().putBoolean("recovery_pending", pending).apply()
            }
        }

        // Ship any crash captured on a previous run (no-op when none pending).
        // Wait for the stored session to restore first: at onCreate the auth
        // status is still Initializing and currentUserOrNull() is null.
        lifecycleScope.launch {
            runCatching {
                val restored = supabase.auth.sessionStatus.first {
                    it is io.github.jan.supabase.gotrue.SessionStatus.Authenticated ||
                        it is io.github.jan.supabase.gotrue.SessionStatus.NotAuthenticated
                }
                if (restored is io.github.jan.supabase.gotrue.SessionStatus.Authenticated) {
                    repo.uploadPendingCrashes()
                    repo.uploadDebugLogIfEnabled()
                }
            }
        }

        // Heal a lost RTDN renewal: if Play knows an active subscription but the
        // profile says free, re-verify server-side. Cheap no-op for everyone else.
        lifecycleScope.launch {
            runCatching {
                if (!billing.supported || repo.auth.currentUserOrNull() == null) return@runCatching
                if (repo.planStatus().isPro) return@runCatching
                val token = billing.currentPurchaseToken() ?: return@runCatching
                repo.verifyPurchase(token)
            }
        }
        setContent {
            val themeVm: ThemeViewModel = hiltViewModel()
            val mode by themeVm.themeMode.collectAsState()
            val palette by themeVm.themePalette.collectAsState()
            val dark = when (mode) {
                ThemeMode.DARK -> true
                ThemeMode.LIGHT -> false
                ThemeMode.SYSTEM -> isSystemInDarkTheme()
            }
            WorkoutMakerTheme(themePalette = palette, darkTheme = dark) {
                Surface {
                    AuthGate { MainScaffold() }
                    // Password-recovery deep link: ask for the new password on
                    // top of whatever is showing.
                    val recovery by AuthDeepLinks.recoveryPending.collectAsState()
                    if (recovery) SetNewPasswordDialog(repo)
                }
            }
        }
    }
}

@Composable
private fun MainScaffold() {
    val nav = rememberNavController()

    // If a workout was in progress when the app was last closed/killed, START on
    // the Strength tab (not Home) so there's no Home→workout flash on launch.
    val context = LocalContext.current
    val startDestination = remember {
        if (File(context.filesDir, "active_session.json").exists()) "strength" else "home"
    }

    // A tapped debrief notification lands on the Home tab (HomeViewModel opens
    // the activity overlay from the same flow). Covers the strength start
    // destination and being parked on any other tab.
    LaunchedEffect(nav) {
        NotificationDeepLinks.openActivity.collect { link ->
            if (link != null) {
                nav.navigate("home") {
                    popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                    launchSingleTop = true
                    restoreState = true
                }
            }
        }
    }

    // Same for a tapped weather-swap line — lands on Home, which renders the
    // WeatherSwapDialog from NotificationDeepLinks.openWeatherPrompt.
    LaunchedEffect(nav) {
        NotificationDeepLinks.openWeatherPrompt.collect { prompt ->
            if (prompt != null) {
                nav.navigate("home") {
                    popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                    launchSingleTop = true
                    restoreState = true
                }
            }
        }
    }

    val snackHost = remember { SnackbarHostState() }
    val snackScope = rememberCoroutineScope()
    val appSnackbar = remember(snackHost, snackScope) {
        AppSnackbar(snackHost, snackScope)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackHost) },
        bottomBar = {
            NavigationBar {
                val current by nav.currentBackStackEntryAsState()
                val dest = current?.destination
                TABS.forEach { tab ->
                    NavigationBarItem(
                        selected = dest?.hierarchy?.any { it.route == tab.route } == true,
                        onClick = {
                            nav.navigate(tab.route) {
                                popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        // Handoffs (Calendar "Log this session", History/Calendar "Edit") need the
        // LOGGER itself on screen. Plain tab navigation restores the strength
        // tab's saved sub-stack — which can have the History screen on top, hiding
        // the logger — so after restoring we pop anything above "strength".
        val openStrengthLogger: () -> Unit = {
            nav.navigate("strength") {
                popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
            nav.popBackStack("strength", false)
        }
        CompositionLocalProvider(
            LocalAppSnackbar provides appSnackbar,
        ) {
        // consumeWindowInsets, so a screen that wants to sit above the keyboard
        // (Modifier.imePadding, see CoachScreen) lifts by the keyboard height
        // MINUS the bottom bar we already padded for, not the whole thing —
        // otherwise the composer floats a nav-bar's height clear of the keys.
        // No layout change on its own: it only re-bases inset modifiers below.
        NavHost(
            nav,
            startDestination = startDestination,
            modifier = Modifier.padding(padding).consumeWindowInsets(padding),
        ) {
            composable("home") {
                HomeScreen(
                    // singleTop: a fast double-tap must not stack two copies
                    // (Back then appears broken, popping to the duplicate).
                    onOpenRecoveryHistory = { nav.navigate("recovery-history") { launchSingleTop = true } },
                    onOpenSettings = {
                        nav.navigate("settings") {
                            popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                            launchSingleTop = true
                            restoreState = true
                        }
                    },
                    onCustomizeHome = { nav.navigate("customize-home") { launchSingleTop = true } },
                )
            }
            composable("customize-home") {
                CustomizeHomeScreen(onBack = { nav.popBackStack() })
            }
            composable("recovery-history") {
                RecoveryHistoryScreen(onBack = { nav.popBackStack() })
            }
            composable("body-history") {
                BodyHistoryScreen(onBack = { nav.popBackStack() })
            }
            composable("coach") {
                CoachScreen(onOpenCalendar = {
                    nav.navigate("calendar") {
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                })
            }
            composable("calendar") {
                CalendarScreen(onOpenStrength = openStrengthLogger)
            }
            composable("strength") {
                StrengthScreen(
                    onOpenHistory = { nav.navigate("history") { launchSingleTop = true } },
                    onOpenStats = { exercise ->
                        val encoded = URLEncoder.encode(exercise, "UTF-8")
                        nav.navigate("exercise-stats/$encoded")
                    },
                    onOpenStatsPicker = { nav.navigate("exercise-stats") },
                )
            }
            composable("exercise-stats") { backStackEntry ->
                // Reuse the live StrengthViewModel from the "strength" back stack
                // entry (not a fresh instance) — it owns session-restore/handoff
                // logic that must not run twice.
                val parentEntry = remember(backStackEntry) { nav.getBackStackEntry("strength") }
                val vm: StrengthViewModel = hiltViewModel(parentEntry)
                val logged by vm.loggedExercises.collectAsState()
                ExerciseStatsPickerScreen(
                    exercises = logged,
                    onPick = { exercise ->
                        val encoded = URLEncoder.encode(exercise, "UTF-8")
                        nav.navigate("exercise-stats/$encoded")
                    },
                    onBack = { nav.popBackStack() },
                )
            }
            composable("exercise-stats/{exercise}") { backStackEntry ->
                val encoded = backStackEntry.arguments?.getString("exercise").orEmpty()
                val exercise = URLDecoder.decode(encoded, "UTF-8")
                val parentEntry = remember(backStackEntry) { nav.getBackStackEntry("strength") }
                val vm: StrengthViewModel = hiltViewModel(parentEntry)
                ExerciseStatsScreen(vm, exercise, onBack = { nav.popBackStack() })
            }
            composable("history") {
                WorkoutHistoryScreen(
                    onBack = { nav.popBackStack() },
                    // History sits directly ON TOP of the Strength tab, so the live
                    // StrengthViewModel — which the edit handoff has just switched
                    // into edit mode (nav = Active) — is still on the back stack.
                    // Pop straight back to it. Do NOT reuse the cross-tab
                    // openStrengthLogger here: its popUpTo(saveState)+restoreState
                    // recreates the StrengthViewModel, discarding that in-memory
                    // edit state, so the app bounced back to the Home tab and the
                    // edit only reappeared after a force-close (from the persisted
                    // active_session.json).
                    onEditInLogger = { nav.popBackStack("strength", false) },
                )
            }
            composable("settings") {
                SettingsScreen(onOpenBodyHistory = { nav.navigate("body-history") { launchSingleTop = true } })
            }
        }
        }
    }
}
