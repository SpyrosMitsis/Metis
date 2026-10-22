package com.workoutmaker.app.ui

import com.workoutmaker.app.util.runCatching

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.BackendConfig
import com.workoutmaker.app.util.friendlyAuthError
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.ui.screens.auth.LoginScreen
import dagger.hilt.android.lifecycle.HiltViewModel
import io.github.jan.supabase.gotrue.SessionStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject
import com.workoutmaker.app.ui.screens.onboarding.OnboardingScreen
import com.workoutmaker.app.ui.screens.onboarding.OnboardingViewModel
import com.workoutmaker.app.data.accountExists

@HiltViewModel
class AuthViewModel @Inject constructor(
    val repo: WorkoutRepository,
    val backend: BackendConfig,
) : ViewModel() {
    val sessionStatus: StateFlow<SessionStatus> = repo.auth.sessionStatus as StateFlow<SessionStatus>
    val error = MutableStateFlow<String?>(null)
    // Non-error guidance (confirmation mail sent, reset mail sent…).
    val info = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)
    // Set when a sign-in failed because no account exists: the form flips to Create.
    val promptCreate = MutableStateFlow(false)

    // Offline cold start: the SDK reports NetworkError when it can't refresh the
    // stored session. If one IS stored locally, let the user into the app (the
    // screens render their cached data); the SDK keeps retrying in the background
    // and flips to Authenticated once the connection returns. Null = not checked.
    val offlineWithSession = MutableStateFlow<Boolean?>(null)

    init {
        viewModelScope.launch {
            sessionStatus.collectLatest { st ->
                if (st is SessionStatus.NetworkError && offlineWithSession.value == null) {
                    offlineWithSession.value =
                        runCatching { repo.auth.sessionManager.loadSession() != null }.getOrDefault(false)
                }
            }
        }
    }

    fun signIn(email: String, pw: String) = viewModelScope.launch {
        busy.value = true
        error.value = null
        info.value = null
        promptCreate.value = false
        runCatching { repo.signIn(email.trim(), pw) }
            .onFailure { t ->
                // Supabase returns the same "invalid credentials" for a wrong
                // password AND a missing account. Ask the server which it is so we
                // can point a new user at Create instead of a dead end.
                if ((t.message ?: "").contains("Invalid login credentials", true)) {
                    when (repo.accountExists(email.trim())) {
                        false -> { error.value = "No account yet. Create one below."; promptCreate.value = true }
                        true -> error.value = "Wrong password. Try again or reset it."
                        null -> error.value = friendlyAuthError(t)
                    }
                } else {
                    error.value = friendlyAuthError(t)
                }
            }
        busy.value = false
    }

    fun signUp(email: String, pw: String) = viewModelScope.launch {
        busy.value = true
        error.value = null
        info.value = null
        runCatching { repo.signUp(email.trim(), pw) }
            .onSuccess {
                // With email confirmation enabled there's no session yet. Say
                // what to do instead of failing silently.
                if (repo.auth.currentSessionOrNull() == null) {
                    info.value = "Almost there. Confirm your email from the link in your inbox, then sign in."
                }
            }
            .onFailure { error.value = friendlyAuthError(it) }
        busy.value = false
    }

    fun forgotPassword(email: String) = viewModelScope.launch {
        if (email.isBlank()) {
            error.value = "Type your email above first, then tap “Forgot password?”."
            return@launch
        }
        busy.value = true
        error.value = null
        runCatching { repo.resetPassword(email.trim()) }
            .onSuccess { info.value = "Check your email. We sent you a link to set a new password." }
            .onFailure { error.value = friendlyAuthError(it) }
        busy.value = false
    }
}

// Coarse routing bucket so the gate can animate between whole surfaces.
private enum class GateState { Login, App, Spinner }

@Composable
fun AuthGate(vm: AuthViewModel = hiltViewModel(), content: @Composable () -> Unit) {
    val status by vm.sessionStatus.collectAsStateSafe()
    val offlineWithSession by vm.offlineWithSession.collectAsStateSafe()

    val bucket = when (status) {
        is SessionStatus.Authenticated -> GateState.App
        is SessionStatus.NotAuthenticated -> GateState.Login
        // Can't reach the server: with a locally-saved session, enter the app on
        // cached data (the SDK keeps retrying and signs in when back online).
        // Without one there's no account to show, so fall back to the login form.
        is SessionStatus.NetworkError -> when (offlineWithSession) {
            true -> GateState.App
            false -> GateState.Login
            null -> GateState.Spinner
        }
        else -> GateState.Spinner
    }

    // Success buzz only on an actual Login → App transition, not on cold-start
    // session restore (which goes Spinner → App).
    val haptics = LocalHapticFeedback.current
    val previous = remember { mutableStateOf<GateState?>(null) }
    LaunchedEffect(bucket) {
        if (previous.value == GateState.Login && bucket == GateState.App) {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        }
        previous.value = bucket
    }

    AnimatedContent(
        targetState = bucket,
        transitionSpec = {
            (fadeIn(tween(350)) + scaleIn(initialScale = 0.98f, animationSpec = tween(350)))
                .togetherWith(fadeOut(tween(150)))
        },
        label = "authGate",
    ) { state ->
        when (state) {
            GateState.App -> androidx.compose.runtime.key(vm.repo.auth.currentUserOrNull()?.id) { OnboardingGate(content) }
            GateState.Login -> LoginScreen(vm)
            GateState.Spinner -> CenteredSpinner()
        }
    }
}

@Composable
private fun CenteredSpinner() {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { CircularProgressIndicator() }
}

@Composable
private fun OnboardingGate(
    content: @Composable () -> Unit,
    vm: OnboardingViewModel = hiltViewModel(),
) {
    // Keyed on the signed-in user: an account switch in the same process (e.g.
    // sign out then sign up) must re-run the scope guard + onboarding check
    // instead of serving the previous user's cached answer.
    LaunchedEffect(vm.currentUserId()) { vm.recheck() }
    val complete by vm.complete.collectAsStateSafe()
    val accountError by vm.accountError.collectAsStateSafe()
    if (accountError != null) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally) {
            androidx.compose.material3.Text(accountError!!)
            androidx.compose.material3.Button(onClick = { vm.recheck() }) { androidx.compose.material3.Text("Retry") }
        }
        return
    }
    when (complete) {
        true -> content()
        false -> OnboardingScreen(vm)
        null -> CenteredSpinner()
    }
}
