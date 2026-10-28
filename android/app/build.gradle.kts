import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

// Gradle does NOT expose arbitrary local.properties keys via findProperty
// (only sdk.dir is special-cased), so load the file explicitly. Resolution
// order: local.properties → -P/gradle.properties → env var → "".
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(key: String): String =
    localProps.getProperty(key)
        ?: (project.findProperty(key) as String?)
        ?: System.getenv(key)
        ?: ""

android {
    namespace = "com.workoutmaker.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.workoutmaker.app"
        minSdk = 26
        targetSdk = 35
        // Every Play upload needs a versionCode bump.
        versionCode = 2
        versionName = "1.0.0"

        // Supabase project values are injected at build time from gradle
        // properties (see local.properties / CI secrets). These are public
        // anon-safe values, mirroring the web app's NEXT_PUBLIC_* vars.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Where Room writes the exported schema (see AppDatabase.exportSchema).
        // The generated app/schemas/*.json is committed as the baseline.
        ksp { arg("room.schemaLocation", "$projectDir/schemas") }
        buildConfigField("String", "SUPABASE_URL", "\"${secret("SUPABASE_URL")}\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"${secret("SUPABASE_ANON_KEY")}\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Upload keystore for Play (never committed; values via local.properties /
    // CI secrets, same resolution as the Supabase values above). Release builds
    // fall back to unsigned when absent so contributors can still compile.
    val hasReleaseKeystore = secret("RELEASE_STORE_FILE").isNotEmpty()
    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(secret("RELEASE_STORE_FILE"))
                storePassword = secret("RELEASE_STORE_PASSWORD")
                keyAlias = secret("RELEASE_KEY_ALIAS")
                keyPassword = secret("RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Contributors/self-hosters without an upload keystore still get an
            // installable (debug-signed) release APK, matching the README flow.
            signingConfig = if (hasReleaseKeystore) signingConfigs.getByName("release")
            else signingConfigs.getByName("debug")
        }
    }

    // play = Google Play build with the (proprietary) Billing library.
    // foss = no Google dependencies at all — F-Droid-able, Pro UI never shows
    // (billing unsupported + self-hosted servers don't advertise hosted_ai).
    flavorDimensions += "distribution"
    productFlavors {
        create("play") { dimension = "distribution"; isDefault = true }
        create("foss") { dimension = "distribution" }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.2")

    // Compose + Material 3
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.8.9")

    // Play Billing — play flavor only, so foss builds stay Google-free.
    "playImplementation"("com.android.billingclient:billing-ktx:7.1.1")

    // Hilt DI
    implementation("com.google.dagger:hilt-android:2.52")
    ksp("com.google.dagger:hilt-android-compiler:2.52")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")
    implementation("androidx.hilt:hilt-work:1.2.0")
    ksp("androidx.hilt:hilt-compiler:1.2.0")

    // Supabase Kotlin SDK (auth + postgrest + realtime)
    implementation(platform("io.github.jan-tennert.supabase:bom:2.6.0"))
    implementation("io.github.jan-tennert.supabase:postgrest-kt")
    implementation("io.github.jan-tennert.supabase:gotrue-kt")   // auth (renamed to auth-kt in 3.x)
    implementation("io.github.jan-tennert.supabase:realtime-kt")
    implementation("io.github.jan-tennert.supabase:functions-kt")
    implementation("io.ktor:ktor-client-okhttp:2.3.12")

    // Room offline cache
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // WorkManager for the morning check-in reminder
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // DataStore — device-local app preferences (units, rest defaults, etc.)
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Health Connect — read HRV / resting HR / sleep / steps from the device.
    // Pinned to the alpha line: rc02+ force compileSdk 36 / AGP 8.9.1; this
    // version exposes the same records + permission APIs against compileSdk 35.
    implementation("androidx.health.connect:connect-client:1.1.0-alpha07")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.2")

    testImplementation("junit:junit:4.13.2")

    // Instrumented tests (run parse + Room insert on a real device).
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core-ktx:1.7.0")
    // New Android versions removed InputManager.getInstance reflection.
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    // Compose UI tests. The recent coach regressions were LAYOUT decisions
    // (chips under a full-size list took no taps; a banner fired on prose that
    // only described the week), which only a composed screen can catch.
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
