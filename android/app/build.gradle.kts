plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The web UI is the same public/ folder the Windows and iPhone apps use, bundled unchanged.
val copyPublic by tasks.registering(Copy::class) {
    from(rootProject.file("../public"))
    into(layout.buildDirectory.dir("generated/ufti-assets/public"))
}
tasks.named("preBuild") { dependsOn(copyPublic) }
tasks.matching { it.name != "copyPublic" && (it.name.endsWith("Assets") || it.name.contains("Lint")) }.configureEach { dependsOn(copyPublic) }

android {
    namespace = "com.ufti.android"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.ufti.android"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/ufti-assets"))
    buildTypes {
        release {
            // Sideloaded builds: signed with the debug key so the APK installs. Replace for a Play Store release.
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
