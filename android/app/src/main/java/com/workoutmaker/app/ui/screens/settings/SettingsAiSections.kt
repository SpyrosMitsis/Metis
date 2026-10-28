package com.workoutmaker.app.ui.screens.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.TextButton
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.LlmProvider
import com.workoutmaker.app.data.format
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.ProviderPicker
import com.workoutmaker.app.ui.components.SectionLabel
import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import com.workoutmaker.app.billing.TIP_FALLBACK_PRICES
import com.workoutmaker.app.billing.TIP_PRODUCT_IDS
import com.workoutmaker.app.ui.screens.onboarding.InjuryEditor
import com.workoutmaker.app.data.modelOverrides
import com.workoutmaker.app.data.planStatus
import com.workoutmaker.app.data.refreshMemory
import com.workoutmaker.app.data.saveKnowledge
import com.workoutmaker.app.data.saveMemory
import com.workoutmaker.app.data.saveProfile
import com.workoutmaker.app.data.saveSoul
import com.workoutmaker.app.data.setUseHostedAi

// "What your coach knows about you" — the three coach-memory documents in one
// place: hard constraints (coach_knowledge ≈ user.md), the rolling notes
// (training_memory ≈ memory.md), and the coach's identity (coach_soul ≈ soul.md).
@Composable
internal fun KnowledgeSection(vm: SettingsViewModel) {
    val knowledge by vm.knowledge.collectAsStateSafe()
    val knowledgeStatus by vm.knowledgeStatus.collectAsStateSafe()
    val memory by vm.memory.collectAsStateSafe()
    val memoryStatus by vm.memoryStatus.collectAsStateSafe()
    val soul by vm.soul.collectAsStateSafe()
    val soulStatus by vm.soulStatus.collectAsStateSafe()
    val busy by vm.busy.collectAsStateSafe()
    val profile by vm.profile.collectAsStateSafe()
    // Same structured editor onboarding uses; edits profile.injuries.
    SectionCard {
        // The count headline lives in the screen header now (detailHeader).
        InjuryEditor(profile.injuries) { v -> vm.updateProfile { it.copy(injuries = v) } }
        Button(onClick = { vm.saveProfile() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Save rules") }
    }
    SectionCard(title = "Notes for the coach") {
        Text(
            "Durable facts your coach must respect on every plan, e.g. \"left knee, avoid deep lunges\", " +
                "\"no leg press machine\", \"only dumbbells at home\", \"hate burpees\". The coach chat updates this " +
                "automatically, and you can edit it here.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            knowledge, { vm.updateKnowledge(it) }, label = { Text("Constraints & preferences") },
            placeholder = { Text("- Left knee tendinitis, avoid deep knee flexion\n- Home gym: dumbbells + bands only\n- Runs only before work (mornings)") },
            minLines = 5, modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { vm.saveKnowledge() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Save knowledge") }
        knowledgeStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
    SectionCard(title = "Coach's notes") {
        Text(
            "Your coach's running notes, durable patterns it has learned from your sessions, " +
                "feedback and PRs (e.g. how you respond to volume, recurring soreness, what motivates you). " +
                "It carries these into every chat and plan. Tap Refresh to re-derive them from recent training, " +
                "or edit them directly.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            memory, { vm.updateMemory(it) }, label = { Text("Coach's notes about you") },
            placeholder = { Text("Builds up automatically as you train, or jot something here.") },
            minLines = 4, modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { vm.refreshMemory() }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Refresh") }
            Button(onClick = { vm.saveMemory() }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Save notes") }
        }
        memoryStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
    SectionCard(title = "Coach's identity") {
        Text(
            "Your coach's soul, who it is to you: its voice, coaching philosophy, and the " +
                "story of how you two train together. It deepens slowly on its own; you rarely need to " +
                "touch it, but you can shape its personality here. Leave it blank to use the default coach.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            soul, { vm.updateSoul(it) }, label = { Text("Coach's identity & your story") },
            placeholder = { Text("Seeded with a default coach personality, then deepened over time as you train together.") },
            minLines = 5, modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { vm.saveSoul() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Save soul") }
        soulStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
}

// Pro (hosted AI) — rendered only when this build can bill (play flavor) AND
// the server advertises a hosted key. Self-hosted stacks and foss builds
// never see any of this.
@Composable
internal fun ProSection(vm: SettingsViewModel) {
    val plan = vm.planStatus.collectAsStateSafe().value
    val busy = vm.proBusy.collectAsStateSafe().value
    val error = vm.proError.collectAsStateSafe().value
    val context = LocalContext.current

    SectionCard(title = if (plan.isPro) "Pro, hosted AI" else "Pro") {
        if (plan.isPro) {
            ToggleRow(
                title = "Use hosted AI",
                subtitle = "Coach and workouts run on our key, no setup. Turn off to use your own keys below.",
                checked = plan.useHostedAi,
                onChange = { vm.setUseHostedAi(it) },
            )
            Text(
                "Fair-use allowance applies; if you hit it, generation pauses until it resets (or add your own key below).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(
                onClick = {
                    val url = "https://play.google.com/store/account/subscriptions" +
                        "?sku=${com.workoutmaker.app.billing.PRO_PRODUCT_ID}&package=${context.packageName}"
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse(url)),
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Manage subscription") }
        } else {
            Text(
                "Skip the API keys. Pro runs the coach and workout generation on a fast hosted model, with a fair-use allowance.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = { (context as? Activity)?.let { vm.buyPro(it) } },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Working…" else "Get Pro") }
            TextButton(onClick = { vm.restorePro() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text("Restore purchase")
            }
        }
        if (error != null) {
            Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
}

// Ko-fi page used by builds without Play Billing (foss).
internal const val KOFI_URL = "https://ko-fi.com/spyrosmitsis"

@Composable
internal fun SupportSection(vm: SettingsViewModel) {
    val context = LocalContext.current
    SectionCard {
        // Honest about both rails: Pro is a subscription and a tip is not, and
        // the copy must not imply the app has only one of them.
        Text(
            "You're on the free path, your own key paid straight to the provider. Pro swaps that " +
                "for hosted AI; a tip is the same help without the subscription.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (vm.tipsSupported) {
            val busy = vm.tipBusy.collectAsStateSafe().value
            val status = vm.tipStatus.collectAsStateSafe().value
            val prices = vm.tipPrices.collectAsStateSafe().value
            LaunchedEffect(Unit) { vm.loadTipPrices() }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TIP_PRODUCT_IDS.forEach { id ->
                    // Play's price when it has answered, our own until then, so the
                    // label can never contradict the checkout sheet.
                    val label = prices[id]
                        ?: TIP_FALLBACK_PRICES[id]
                        ?: "Tip"
                    OutlinedButton(
                        onClick = { (context as? Activity)?.let { vm.sendTip(it, id) } },
                        enabled = !busy,
                        modifier = Modifier.weight(1f),
                    ) { Text(if (busy) "…" else label) }
                }
            }
            status?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
        } else {
            // Ko-fi (browser) is the only rail that can take an arbitrary amount;
            // Play Billing tips are fixed products. Validate: must be > 0.
            val uriHandler = LocalUriHandler.current
            var custom by remember { mutableStateOf("") }
            val amount = custom.toDoubleOrNull()
            val valid = amount != null && amount > 0.0
            OutlinedTextField(
                value = custom,
                // Digits + one decimal only, so a minus sign can't make it negative.
                onValueChange = { custom = it.filter { c -> c.isDigit() || c == '.' } },
                label = { Text("Custom amount (€)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
            )
            if (custom.isNotBlank() && !valid) {
                Text(
                    "Enter an amount greater than 0.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                )
            }
            Button(
                onClick = { runCatching { uriHandler.openUri("$KOFI_URL?amount=$custom") } },
                enabled = valid,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (valid) "Tip €$custom on Ko-fi" else "Tip on Ko-fi") }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AiSection(vm: SettingsViewModel) {
    val proAvailable = vm.proAvailable.collectAsStateSafe().value
    val plan = vm.planStatus.collectAsStateSafe().value
    if (proAvailable) ProSection(vm)

    // A Pro user on hosted AI shouldn't wade through key plumbing; keep the
    // BYO section one tap away instead of front and center.
    val hostedActive = proAvailable && plan.isPro && plan.useHostedAi
    var byoExpanded by rememberSaveable { mutableStateOf(false) }
    if (hostedActive && !byoExpanded) {
        TextButton(onClick = { byoExpanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text(
                "Advanced: bring your own keys",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    SectionCard(title = "Active provider") {
        // The same picker onboarding uses: choosing a model is one act, and it
        // should not look like two different features in two places.
        ProviderPicker(
            selected = vm.active,
            options = LlmProvider.entries,
            onSelect = { vm.selectProvider(it) },
        )
        Text("✦ = has a free tier. Add a key below; the others act as fallbacks.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        // The model is the single biggest lever on coach quality — the free default
        // is capable but generic. Nudge toward a stronger model without forcing spend.
        Text(
            "Tip: your coach gets noticeably more human and insightful on a stronger model " +
                "(e.g. Claude / Anthropic). Free tiers work fine to start.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
    LlmProvider.entries.forEach { provider -> ProviderCard(Modifier, provider, vm) }
}

@Composable
internal fun ProviderCard(modifier: Modifier, provider: LlmProvider, vm: SettingsViewModel) {
    var key by remember { mutableStateOf("") }
    val result = vm.results[provider.key]
    val overrides by vm.modelOverrides.collectAsStateSafe()
    val llmKeys by vm.llmKeys.collectAsStateSafe()
    val customPrice by vm.customPrice.collectAsStateSafe()
    val saved = llmKeys[provider.key]
    val activeModel = overrides[provider.key] ?: provider.model
    val isCustom = provider == LlmProvider.CUSTOM
    var showModelPicker by remember { mutableStateOf(false) }

    // Custom-provider config: base URL + free-text model id (no fixed defaults).
    var baseUrl by remember(saved?.base_url) { mutableStateOf(saved?.base_url ?: "") }
    var modelId by remember(overrides[provider.key]) { mutableStateOf(overrides[provider.key] ?: "") }

    if (showModelPicker) {
        ModelPickerDialog(provider, vm) { showModelPicker = false }
    }

    SectionCard(modifier, title = "${provider.label}${if (provider.freeTier) "  · free tier" else ""}") {
        if (isCustom) {
            Text(
                "Point at any OpenAI-compatible endpoint. Ollama, LM Studio, vLLM, OpenRouter, a LiteLLM proxy. The phone must be able to reach the URL.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                baseUrl, { baseUrl = it },
                label = { Text("Base URL") },
                placeholder = { Text("http://192.168.1.10:11434/v1") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                modelId, { modelId = it },
                label = { Text("Model id") },
                placeholder = { Text("llama3.1:8b") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            // Optional pricing so the diagnostics screen shows real spend (a BYO
            // endpoint has no known price → cost would otherwise read $0).
            var priceIn by remember(customPrice.first) { mutableStateOf(customPrice.first?.toString() ?: "") }
            var priceOut by remember(customPrice.second) { mutableStateOf(customPrice.second?.toString() ?: "") }
            Text("Pricing (optional, $ per 1M tokens), for cost tracking only.",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    priceIn, { priceIn = it },
                    label = { Text("Input") }, placeholder = { Text("0.20") },
                    singleLine = true, modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                )
                OutlinedTextField(
                    priceOut, { priceOut = it },
                    label = { Text("Output") }, placeholder = { Text("0.60") },
                    singleLine = true, modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                )
                TextButton(onClick = { vm.setCustomPricing(priceIn.toDoubleOrNull(), priceOut.toDoubleOrNull()) }) {
                    Text("Save")
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(activeModel, style = MaterialTheme.typography.bodySmall)
                    if (overrides[provider.key] != null) {
                        Text("custom, default is ${provider.model}", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                TextButton(onClick = { showModelPicker = true }) { Text("Change model") }
            }
        }
        // What's already configured, masked — so you know which key is in use.
        saved?.let { s ->
            Text(
                "Saved key: ${s.key_hint ?: "••••••••"} · " + when (s.is_valid) {
                    true -> "valid ✓"
                    false -> "invalid ✗"
                    null -> "untested"
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (s.is_valid == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
            if (isCustom && !s.base_url.isNullOrBlank()) {
                Text("Endpoint: ${s.base_url}", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        OutlinedTextField(
            key, { key = it },
            label = { Text(if (saved != null) "API key (replace)" else if (isCustom) "API key (any value if none)" else "API key") },
            visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        // Custom needs a base URL + model id too; others just need the key.
        val testing by vm.testing.collectAsStateSafe()
        val busy = testing == provider.key
        val canTest = !busy && key.isNotBlank() && (!isCustom || (baseUrl.isNotBlank() && modelId.isNotBlank()))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { vm.testKey(provider, key, false, baseUrl.takeIf { isCustom }, modelId.takeIf { isCustom }) },
                enabled = canTest,
            ) { Text(if (busy) "Testing…" else "Save & Test") }
            OutlinedButton(
                onClick = { vm.testKey(provider, key, true, baseUrl.takeIf { isCustom }, modelId.takeIf { isCustom }) },
                enabled = canTest,
            ) { Text("Test Gen") }
        }
        result?.let {
            Text(
                if (it.is_valid) "✓ valid · ~$${"%.4f".format(it.estimated_cost_usd)}/workout" else "✗ ${it.error ?: "invalid"}",
                style = MaterialTheme.typography.bodySmall,
                color = if (it.is_valid) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            )
        }
    }
}

// Dynamic model picker: pulls the live model list from the provider's API
// (with the user's saved key) and stores the chosen id on the profile.
@Composable
internal fun ModelPickerDialog(provider: LlmProvider, vm: SettingsViewModel, onClose: () -> Unit) {
    val overrides by vm.modelOverrides.collectAsStateSafe()
    val busy by vm.modelBusy.collectAsStateSafe()
    val list = vm.modelLists[provider.key]
    val current = overrides[provider.key]

    LaunchedEffect(provider.key) { if (list == null) vm.loadModels(provider) }

    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = { TextButton(onClick = onClose) { Text("Close") } },
        title = { Text("${provider.label} model") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                // Default always available, even before/without a fetched list.
                ModelRow(
                    label = "Default, ${provider.model}",
                    selected = current == null,
                    onClick = { vm.setModel(provider, null); onClose() },
                )
                when {
                    busy == provider.key -> Row(
                        Modifier.fillMaxWidth().padding(vertical = 16.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(
                            Modifier.padding(end = 10.dp).then(Modifier.size(18.dp)), strokeWidth = 2.dp)
                        Text("Fetching available models…", style = MaterialTheme.typography.bodySmall)
                    }
                    list?.error != null -> {
                        Text(list.error!!, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
                        OutlinedButton(onClick = { vm.loadModels(provider) }, modifier = Modifier.fillMaxWidth()) {
                            Text("Retry")
                        }
                    }
                    else -> list?.models.orEmpty().forEach { m ->
                        ModelRow(label = m, selected = current == m,
                            onClick = { vm.setModel(provider, m); onClose() })
                    }
                }
            }
        },
    )
}

@Composable
private fun ModelRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label, Modifier.padding(start = 6.dp), style = MaterialTheme.typography.bodyMedium)
    }
}
