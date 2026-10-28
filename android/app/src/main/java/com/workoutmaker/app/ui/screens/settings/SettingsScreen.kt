package com.workoutmaker.app.ui.screens.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Favorite
import androidx.compose.material.icons.outlined.FitnessCenter
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.VolunteerActivism
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.ui.theme.amberAccent
import androidx.hilt.navigation.compose.hiltViewModel
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.ScreenScaffold
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.LocalAppSnackbar
import com.workoutmaker.app.util.friendlyError
import com.workoutmaker.app.data.races

// Grouped by INTENT, in the order a user reasons: who I am (everything the
// coach knows about the athlete, in one place), how it plans, phone/app
// concerns, power tools, account. Ids are stable — only grouping/copy changes.
internal val SETTINGS_GROUPS = listOf(
    SettingsGroup("About you", listOf(
        SettingsItem("profile", Icons.Outlined.Person, "About you", "Name, body & body trends"),
        SettingsItem("sports", Icons.Outlined.FitnessCenter, "Sports & goals", "Sports, goals, level & equipment"),
        SettingsItem("week", Icons.Outlined.CalendarMonth, "Your training week", "Availability & periodization"),
        SettingsItem("races", Icons.Outlined.Flag, "Goals & races", "Goal races, targets & countdown"),
        SettingsItem("zones", Icons.Outlined.Favorite, "Your numbers & zones", "FTP, paces, lifts & HR zones"),
        SettingsItem("knowledge", Icons.Outlined.Psychology, "Injuries & constraints", "Hard rules the coach must respect"),
    )),
    SettingsGroup("Coach & planning", listOf(
        SettingsItem("ai", Icons.Outlined.AutoAwesome, "AI model", "Model choice & API keys, the biggest quality lever"),
        SettingsItem("planning", Icons.Outlined.CalendarMonth, "Planning", "Auto-plan, weekly load & challenge level"),
    )),
    SettingsGroup("App", listOf(
        SettingsItem("tour", Icons.Outlined.AutoAwesome, "App tour", "Replay the guide to the main features"),
        SettingsItem("connections", Icons.Outlined.Link, "Connections", "Intervals.icu, Health Connect & calendar"),
        SettingsItem("notifications", Icons.Outlined.Notifications, "Notifications", "Morning brief, rest alerts & vibration"),
        SettingsItem("defaults", Icons.Outlined.FitnessCenter, "Units & gym session", "Units, rest timer, barbell, screen"),
        SettingsItem("appearance", Icons.Outlined.Palette, "Appearance", "Theme & palette"),
    )),
    SettingsGroup("Data", listOf(
        SettingsItem("data", Icons.Outlined.Download, "Import & export", "Strong/Hevy import · CSV backup"),
        SettingsItem("diagnostics", Icons.Outlined.MonitorHeart, "Diagnostics", "AI generation log & cost"),
        SettingsItem("debug_log", Icons.Outlined.BugReport, "Debug logs", "Kept on your phone · share only if you turn it on"),
    )),
    SettingsGroup("Account", listOf(
        SettingsItem("account", Icons.Outlined.AccountCircle, "About & account", "Version & sign out"),
        SettingsItem("support", Icons.Outlined.VolunteerActivism, "Support the developer", "Tips keep this app alive"),
    )),
)

@Composable
fun SettingsScreen(vm: SettingsViewModel = hiltViewModel(), onOpenBodyHistory: () -> Unit = {}, onStartTour: () -> Unit = {}) {
    LaunchedEffect(Unit) { vm.load() }
    // Save confirmations / errors go to the one app-wide snackbar.
    val snackbar = LocalAppSnackbar.current
    val saveStatus by vm.saveStatus.collectAsStateSafe()
    LaunchedEffect(saveStatus) {
        val s = saveStatus ?: return@LaunchedEffect
        snackbar?.show(if (s.startsWith("✓")) s else friendlyError(s))
        vm.saveStatus.value = null
    }
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(enabled = open != null) { open = null }

    if (open == null) {
        SettingsIndex(vm, onOpen = { if (it == "tour") onStartTour() else open = it })
    } else {
        SettingsDetail(open!!, vm, onOpenBodyHistory) { open = null }
    }
}

/** Everything the index reads, gathered once so the rows stay a pure function of it. */
@Composable
private fun rememberSettingsSnapshot(vm: SettingsViewModel): SettingsSnapshot {
    val profile by vm.profile.collectAsStateSafe()
    val races by vm.races.collectAsStateSafe()
    val llmKeys by vm.llmKeys.collectAsStateSafe()
    val plan by vm.planStatus.collectAsStateSafe()
    val intervals by vm.intervalsSaved.collectAsStateSafe()
    val autoPlan by vm.autoPlan.collectAsStateSafe()
    val knowledge by vm.knowledge.collectAsStateSafe()
    val settings by vm.appSettings.collectAsStateSafe()
    val hushed by vm.hushedNumbers.collectAsStateSafe()
    val healthStatus by vm.healthStatus.collectAsStateSafe()
    return SettingsSnapshot(
        profile = profile,
        races = races,
        provider = vm.active,
        hasProviderKey = llmKeys.isNotEmpty(),
        isPro = plan.isPro,
        intervalsConnected = intervals != null,
        healthConnected = vm.healthAvailable && healthStatus?.startsWith("✓") == true,
        autoPlan = autoPlan,
        knowledgeLines = knowledge.lines().count { it.isNotBlank() },
        settings = settings,
        email = vm.userEmail(),
        hushedNumbers = hushed,
    )
}

@Composable
internal fun SettingsIndex(vm: SettingsViewModel, onOpen: (String) -> Unit) {
    val snap = rememberSettingsSnapshot(vm)
    var query by rememberSaveable { mutableStateOf("") }
    val pending = remember(snap) { unfinishedSetup(snap) }

    // A one-line status of what this coach currently IS, so the header answers
    // "which model, how many sports, is the watch talking to it" without a tap.
    val status = listOfNotNull(
        if (snap.isPro) "Pro" else snap.provider.label,
        "${snap.profile.sports.size} sport${if (snap.profile.sports.size == 1) "" else "s"}"
            .takeIf { snap.profile.sports.isNotEmpty() },
        "Intervals.icu linked".takeIf { snap.intervalsConnected },
    ).joinToString(" · ")

    ScreenScaffold(title = "Settings", subtitle = status, eyebrow = "PREFERENCES") { mod ->
        OutlinedTextField(
            query,
            { query = it },
            modifier = mod,
            placeholder = { Text("Search settings") },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear search") }
                }
            },
            singleLine = true,
            shape = RoundedCornerShape(50),
        )

        // Read the clock once per composition, not per frame: the card's window
        // is a week wide, so nothing here needs to tick.
        val nudge by vm.setupNudge.collectAsStateSafe()
        val canNudge = remember(nudge) { setupCardVisible(nudge, System.currentTimeMillis()) }
        if (pending.isNotEmpty() && query.isBlank() && canNudge) {
            FinishSetupCard(pending, nudge, mod, onOpen) { vm.dismissSetupCard() }
        }

        val groups = remember(query) { filterSettings(query) }
        if (groups.isEmpty()) {
            Text(
                "Nothing matches \"$query\".",
                mod.padding(top = 8.dp),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        groups.forEach { group ->
            Text(
                group.header.uppercase(),
                mod.padding(start = 4.dp, top = 4.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
            )
            SectionCard(mod) {
                group.items.forEachIndexed { i, item ->
                    val value = settingsRowValue(item.id, snap)
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpen(item.id) }.padding(vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            item.icon,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(end = 14.dp).size(22.dp),
                        )
                        Text(
                            item.title,
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        // The value, not a description of the screen. Amber when
                        // it is still missing, which is the same colour the setup
                        // card above uses for the same fact.
                        if (value.text.isNotBlank()) {
                            Text(
                                value.text,
                                Modifier.widthIn(max = 136.dp).padding(end = 6.dp),
                                style = MaterialTheme.typography.labelMedium,
                                color = if (value.unfinished) amberAccent() else MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.End,
                            )
                        }
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.outline)
                    }
                    if (i < group.items.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHigh)
                }
            }
        }
    }
}

/** Search matches the row's title AND its description, so "keys" still finds AI model. */
internal fun filterSettings(query: String): List<SettingsGroup> {
    val q = query.trim()
    if (q.isBlank()) return SETTINGS_GROUPS
    return SETTINGS_GROUPS.mapNotNull { group ->
        val hits = group.items.filter {
            it.title.contains(q, ignoreCase = true) || it.subtitle.contains(q, ignoreCase = true)
        }
        if (hits.isEmpty()) null else group.copy(items = hits)
    }
}

/**
 * What setup left undone, with a way straight to it. This is what turns the
 * index from a menu into a nudge, and it is the only place in the app that
 * says out loud which unset field is currently costing the athlete something.
 *
 * Dismissable, and cheaply so: every row here is a shortcut to a row in the
 * list below, which carries the same fact in the same amber. Sending the card
 * away costs the athlete no information, only the pressure, and a nudge with no
 * way to decline it is not a nudge.
 *
 * Closing it snoozes a week, three times, and then it is gone for good. The
 * footer says which of those the × is about to do, because "hide" and "never
 * show this again" are different promises and the button should keep the one
 * it makes.
 */
@Composable
private fun FinishSetupCard(
    pending: List<Pair<String, String>>,
    nudge: SetupNudge,
    modifier: Modifier,
    onOpen: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val titles = remember { SETTINGS_GROUPS.flatMap { it.items }.associate { it.id to it.title } }
    val amber = amberAccent()
    Column(
        modifier
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, amber.copy(alpha = 0.45f), RoundedCornerShape(18.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "FINISH SETUP",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = amber,
            )
            HorizontalDivider(Modifier.weight(1f).padding(horizontal = 10.dp), color = amber.copy(alpha = 0.3f))
            Text(
                "${pending.size} left",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            IconButton(onClick = onDismiss, modifier = Modifier.size(28.dp)) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = setupDismissLabel(nudge),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        pending.forEach { (id, why) ->
            Row(
                Modifier.fillMaxWidth().clickable { onOpen(id) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        titles[id] ?: id,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = amber)
            }
        }
        Text(
            if (nudge.dismissals >= SETUP_DISMISS_LIMIT - 1) "Close this and I won't bring it up again."
            else "Close this and I'll leave it a week. These stay in the list below either way.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsDetail(id: String, vm: SettingsViewModel, onOpenBodyHistory: () -> Unit = {}, onBack: () -> Unit) {
    val snap = rememberSettingsSnapshot(vm)
    // No title in the bar: the headline below says something more useful than
    // the row's own name, and having both was the same word twice.
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        // Diagnostics shows live AI activity: refresh on open, or a coach chat
        // from a minute ago is missing until Settings fully reloads.
        LaunchedEffect(id) { if (id == "diagnostics") vm.reloadLogs() }
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            DetailHeader(detailHeader(id, snap))
            when (id) {
                "profile" -> AboutYouSection(vm, onOpenBodyHistory)
                "sports" -> SportsGoalsSection(vm)
                "week" -> TrainingWeekSection(vm)
                "races" -> RacesSection(vm)
                "zones" -> ZonesSection(vm)
                "defaults" -> WorkoutDefaultsSection(vm)
                "planning" -> PlanningSection(vm)
                "knowledge" -> KnowledgeSection(vm)
                "ai" -> AiSection(vm)
                "connections" -> ConnectionsSection(vm)
                "appearance" -> AppearanceSection(vm)
                "notifications" -> NotificationsSection(vm)
                "data" -> DataSection(vm)
                "diagnostics" -> DiagnosticsSection(vm)
                "debug_log" -> DebugLogSection(vm)
                "account" -> AccountSection(vm)
                "support" -> SupportSection(vm)
            }
        }
    }
}

/**
 * Every detail screen's opening: an eyebrow naming the topic, then the state
 * itself as a headline, then the one line that says why the screen exists.
 */
@Composable
private fun DetailHeader(copy: SettingsDetailCopy) {
    Column(
        Modifier.fillMaxWidth().padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            copy.eyebrow,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
            fontWeight = FontWeight.Bold,
        )
        Text(copy.headline, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        if (copy.subtitle != null) {
            Text(
                copy.subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// --- Detail sections -------------------------------------------------------

internal data class SettingsItem(val id: String, val icon: ImageVector, val title: String, val subtitle: String)

internal data class SettingsGroup(val header: String, val items: List<SettingsItem>)
