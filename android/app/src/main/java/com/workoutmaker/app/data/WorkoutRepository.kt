package com.workoutmaker.app.data

import com.workoutmaker.app.util.runCatching

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.gotrue.auth
import io.github.jan.supabase.gotrue.parseSessionFromFragment
import io.github.jan.supabase.gotrue.FlowType
import io.github.jan.supabase.gotrue.providers.builtin.Email
import io.github.jan.supabase.functions.functions
import io.github.jan.supabase.postgrest.postgrest
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.call.body
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import javax.inject.Inject
import javax.inject.Singleton
import com.workoutmaker.app.calendar.DeviceCalendarManager
import com.workoutmaker.app.health.HealthConnectManager
import com.workoutmaker.app.strength.ExerciseCatalog
import com.workoutmaker.app.strength.StrengthDao
import com.workoutmaker.app.util.AppLog
import com.workoutmaker.app.util.CrashReporter
import com.workoutmaker.app.util.serverErrorText
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.time.LocalDate
import androidx.room.withTransaction
import kotlinx.coroutines.CancellationException
import androidx.work.WorkManager

@Singleton
class WorkoutRepository @Inject constructor(
    internal val supabase: SupabaseClient,
    internal val cache: CacheDao,
    internal val prefs: AppPreferences,
    internal val backend: BackendConfig,
    internal val health: HealthConnectManager,
    internal val deviceCalendar: DeviceCalendarManager,
    // The DAO, not StrengthRepository (which depends on this class).
    internal val strengthDao: StrengthDao,
    private val db: AppDatabase,
    private val accounts: AccountCoordinator,
    @ApplicationContext private val appContext: android.content.Context,
) {
    internal val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    // Separate raw ktor client for SSE streaming (functions SDK buffers the body).
    // Needs its own timeouts: a bare HttpClient(OkHttp) inherits OkHttp's 10s
    // readTimeout, which killed coach turns mid-think. The server heartbeats the
    // stream, so a quiet socket past this really is a dead one.
    internal val streamingHttp = HttpClient(OkHttp) {
        install(io.ktor.client.plugins.HttpTimeout) {
            requestTimeoutMillis = 150_000
            socketTimeoutMillis = 150_000
            connectTimeoutMillis = 15_000
        }
    }

    val auth get() = supabase.auth

    // Swallowed errors are still logged so failures aren't invisible in logcat.
    internal fun <T> Result<T>.logFailure(op: String): Result<T> =
        onFailure { AppLog.w("repo", "$op failed", it) }

    suspend fun signIn(email: String, password: String) = accounts.exclusive {
        supabase.auth.signInWith(Email) { this.email = email; this.password = password }
        invalidateProfileCache()
    }

    suspend fun signUp(email: String, password: String) = accounts.exclusive {
        // The confirmation email deep-links back into the app (and signs the
        // user straight in, so onboarding starts immediately).
        supabase.auth.signUpWith(Email, redirectUrl = "workoutmaker://auth/confirmed") {
            this.email = email
            this.password = password
        }

    }

    // Sends the Supabase recovery email; the link deep-links back into the
    // app, which then shows the set-new-password dialog.
    suspend fun resetPassword(email: String) {
        supabase.auth.resetPasswordForEmail(email, redirectUrl = "workoutmaker://auth/reset")
    }

    // After a recovery deep link imported a session, this sets the new password.
    suspend fun updatePassword(newPassword: String) {
        supabase.auth.updateUser { password = newPassword }
    }

    suspend fun signOut() = accounts.exclusive {
        WorkManager.getInstance(appContext).cancelAllWorkByTag("account-sync")
        // Cleanup is required, not best effort. Keep the old auth session if
        // cleanup fails, so another account cannot adopt its unsynced data.
        clearLocalAccountData()
        supabase.auth.signOut()
    }

    suspend fun <T> withAccount(expectedOwner: String? = auth.currentUserOrNull()?.id, block: suspend () -> T): T = accounts.run(
        prepare = {
            auth.awaitInitialization()
            val owner = auth.currentUserOrNull()?.id ?: throw IllegalStateException("No active account")
            if (expectedOwner != null && expectedOwner != owner) throw CancellationException("Account changed")
            ensureAccountScopeLocked(owner)
        },
    ) {
        val owner = auth.currentUserOrNull()?.id ?: throw IllegalStateException("No active account")
        if (expectedOwner != null && expectedOwner != owner) throw CancellationException("Account changed")
        val result = block()
        if (auth.currentUserOrNull()?.id != owner) throw CancellationException("Account changed")
        result
    }

    suspend fun ensureAccountScope() = accounts.exclusive {
        auth.currentUserOrNull()?.id?.let { ensureAccountScopeLocked(it) }
    }

    private suspend fun ensureAccountScopeLocked(uid: String) {
        val owner = prefs.lastAccountUid()
        if (owner == uid) return
        if (owner != null) clearLocalAccountData()
        prefs.setLastAccountUid(uid)
    }

    private suspend fun clearLocalAccountData() {
        invalidateProfileCache()
        prefs.setOnboardingComplete(false)
        db.withTransaction {
            cache.clearWorkouts(); cache.clearSummaries(); cache.clearBriefs(); cache.clearWeekReviews()
            strengthDao.clearSets(); strengthDao.clearWorkouts()
            strengthDao.clearRoutineItems(); strengthDao.clearRoutines()
            strengthDao.clearCustomExercises(); strengthDao.clearFavorites(); strengthDao.clearTombstones()
        }
        ExerciseCatalog.resetCustom()
        java.nio.file.Files.deleteIfExists(File(appContext.filesDir, "active_session.json").toPath())
        deviceCalendar.clearAll()
    }

    suspend fun importAuthLink(uri: android.net.Uri): Boolean = accounts.exclusive {
        val session = if (auth.config.flowType == FlowType.PKCE) {
            auth.exchangeCodeForSession(requireNotNull(uri.getQueryParameter("code")), saveSession = false)
        } else {
            val parsed = auth.parseSessionFromFragment(requireNotNull(uri.fragment))
            parsed.copy(user = auth.retrieveUser(parsed.accessToken))
        }
        auth.importSession(session)
        invalidateProfileCache()
        ensureAccountScopeLocked(requireNotNull(session.user?.id))
        session.type == "recovery" || uri.path?.contains("reset") == true
    }

    // Upload crash files captured by CrashReporter. Best effort: a file stays
    // on disk until its insert succeeds (offline, or migration not pushed yet)
    // or it goes stale; a failed insert stops the batch until next start.
    suspend fun uploadPendingCrashes() {
        for (f in CrashReporter.pending(appContext)) {
            val rec = CrashReporter.parse(f)
            if (rec == null) { f.delete(); continue }
            val ok = runCatching { supabase.postgrest.from("crash_reports").insert(rec) }
                .logFailure("uploadPendingCrashes").isSuccess
            if (ok) f.delete() else break
        }
    }

    // Opt-in upload of the local debug log (AppLog.file()) to the debug_logs
    // table. No-op unless the athlete has turned the setting on. The file is
    // truncated after a successful upload so the next call only sends what's
    // new since then, not the whole history again.
    suspend fun uploadDebugLogIfEnabled() {
        if (!prefs.settings.first().debugLogSharingEnabled) return
        val f = com.workoutmaker.app.util.AppLog.file() ?: return
        if (!f.exists() || f.length() == 0L) return
        val text = runCatching { f.readText() }.getOrNull() ?: return
        val rec = DebugLogRecord(
            version_name = com.workoutmaker.app.BuildConfig.VERSION_NAME,
            version_code = com.workoutmaker.app.BuildConfig.VERSION_CODE,
            flavor = com.workoutmaker.app.BuildConfig.FLAVOR,
            sdk_int = android.os.Build.VERSION.SDK_INT,
            device = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
            log_text = text.takeLast(200_000),
        )
        val ok = runCatching { supabase.postgrest.from("debug_logs").insert(rec) }
            .logFailure("uploadDebugLogIfEnabled").isSuccess
        if (ok) runCatching { f.writeText("") }
    }

    // Permanent server-side account deletion (Play requirement). The edge
    // function cascades through every owned row; afterwards the local session
    // is dead anyway, so clear it like a sign-out.
    suspend fun deleteAccount() = accounts.exclusive {
        supabase.functions.invoke("delete-account")
        clearLocalAccountData()
        supabase.auth.signOut()
    }

    // --- Profile row cache ----------------------------------------------------
    // loadProfile / isOnboardingComplete / loadKnowledge / autoPlanEnabled all
    // used to fire their own full-row select; serve them from one cached fetch,
    // invalidated whenever this client writes the profile.
    @Volatile
    private var profileRowCache: Map<String, JsonElement>? = null
    @Volatile
    private var profileRowFetchedAt: Long = 0L
    @Volatile private var profileRowOwner: String? = null

    // TTL because the row also changes server-side (coach memory/soul evolution,
    // web-app profile edits) — without it those stay invisible until app restart.
    private val profileTtlMs = 5 * 60_000L

    internal suspend fun profileRow(): Map<String, JsonElement>? {
        profileRowCache
            ?.takeIf { profileRowOwner == uid() && System.currentTimeMillis() - profileRowFetchedAt < profileTtlMs }
            ?.let { return it }
        val owner = uid()
        val rows: List<Map<String, JsonElement>> =
            supabase.postgrest.from("user_profiles").select { filter { eq("id", owner) } }.decodeList()
        if (uid() != owner) throw CancellationException("Account changed")
        return rows.firstOrNull()?.also {
            profileRowOwner = owner
            profileRowCache = it
            profileRowFetchedAt = System.currentTimeMillis()
        }
    }

    internal fun invalidateProfileCache() {
        profileRowCache = null
    }

    // ---- Device calendar (opt-in, Settings → App) ---------------------------

    // Busy windows for [days] days from [fromDate] (default today), or null when
    // the toggle is off / permission missing / nothing busy. Times only.
    internal suspend fun calendarBusy(fromDate: String?, days: Int): List<BusyDay>? {
        val enabled = runCatching { prefs.settings.first().calendarRead }.getOrDefault(false)
        if (!enabled || !deviceCalendar.hasReadPermission()) return null
        val from = runCatching { LocalDate.parse(fromDate) }.getOrNull() ?: LocalDate.now()
        return runCatching { deviceCalendar.busyDays(from, days) }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    // Edge-function failures throw with the JSON error body in the message —
    // pull out the human-readable part ({"error": "..."} / {"detail": "..."}).
    // Keeps the truncated raw text as a fallback: this feeds a generation error
    // record, where the transport detail is worth having.
    internal fun fnErrorMessage(t: Throwable): String =
        serverErrorText(t)
            ?: t.message?.take(200)
            ?: "request failed"

    internal fun uid(): String = supabase.auth.currentUserOrNull()?.id ?: ""

    private companion object {
        const val TAG = "WorkoutRepo"
    }
}

// One row of the opt-in debug log upload (debug_logs table); see
// WorkoutRepository.uploadDebugLogIfEnabled.
@kotlinx.serialization.Serializable
data class DebugLogRecord(
    val version_name: String,
    val version_code: Int,
    val flavor: String,
    val sdk_int: Int,
    val device: String,
    val log_text: String,
)
