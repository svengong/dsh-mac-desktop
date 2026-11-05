plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/**
 * The desktop shell's version, which names the release ("dsh-android-0.10.13-arm64.apk").
 *
 * Read from package.json at configuration time so the APK cannot disagree with
 * the file it is published as. `versionName` used to be a hardcoded "0.1.0",
 * which meant every download reported 0.1.0 in Settings → About while the
 * release page said 0.10.13 — and users had no way to tell two builds apart.
 */
val shellVersion: String by lazy {
    val pkg = rootProject.file("../package.json")
    require(pkg.isFile) { "package.json not found next to android/: ${pkg.absolutePath}" }
    val json = groovy.json.JsonSlurper().parse(pkg)
    (json as Map<*, *>)["version"] as? String
        ?: error("package.json has no version: ${pkg.absolutePath}")
}

/**
 * A monotonically increasing integer for the store/update machinery.
 *
 * Android requires versionCode to grow on every update, while versionName is
 * only a label. Derived from the version triple: "0.10.13" -> 0*10000 + 10*100
 * + 13 = 1013. Two builds of the same version share a code, which is correct —
 * they are the same release.
 */
val shellVersionCode: Int by lazy {
    val parts = shellVersion.split("-", "+").first().split(".")
    val major = parts.getOrNull(0)?.toIntOrNull() ?: 0
    val minor = parts.getOrNull(1)?.toIntOrNull() ?: 0
    val patch = parts.getOrNull(2)?.toIntOrNull() ?: 0
    major * 10000 + minor * 100 + patch
}

android {
    namespace = "com.deepseek.harness.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.deepseek.harness.android"
        minSdk = 26
        targetSdk = 35
        versionCode = shellVersionCode
        versionName = shellVersion

        vectorDrawables { useSupportLibrary = true }
    }

    signingConfigs {
        // A released APK's identity IS its signing certificate: Android refuses
        // to replace an installed app whose certificate differs
        // (INSTALL_FAILED_UPDATE_INCOMPATIBLE), so every release must be signed
        // with the same key. This used to be the throwaway `~/.android` debug
        // key — and CI regenerated it on every run, which made each version
        // uninstallable over the last.
        //
        // Local builds keep the convenience key in android/.keystore/ (ignored
        // by git, reproducible, sandbox-friendly). CI instead restores the real
        // key from ANDROID_KEYSTORE_BASE64 into the same path, so the two never
        // diverge in spelling.
        getByName("debug") {
            storeFile = rootProject.file(".keystore/debug.keystore")
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "android"
            keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "androiddebugkey"
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                ?: (System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "android")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Sign with the checked-in debug key so the released APK is
            // INSTALLABLE. Without a signingConfig the release build emits
            // `app-release-unsigned.apk`, which Android refuses to install —
            // a sideload-only app has no Play signing step to fall back on, so
            // an unsigned artifact would be a download that cannot be opened.
            //
            // This is not a secret: the key is the well-known AOSP debug
            // keystore, already gitignored-adjacent in android/.keystore/ and
            // deliberately shared so builds are reproducible anywhere. It
            // provides no security and MUST be replaced with a real upload key
            // the day this app is distributed through a store.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/INDEX.LIST",
                "META-INF/*.kotlin_module",
            )
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.03"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // SSH transport: pure-Java fork of JSch (maintained, Android-friendly).
    implementation("com.github.mwiede:jsch:0.2.20")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
