# minifyEnabled is off for release, these rules exist so enabling it later stays safe.

# --- Eclipse Paho MQTT ---
-keep class org.eclipse.paho.client.mqttv3.** { *; }
-keep class org.eclipse.paho.client.mqttv3.logging.** { *; }
-dontwarn org.eclipse.paho.**
-keepnames class org.eclipse.paho.client.mqttv3.internal.**

# --- OkHttp / Okio ---
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- Health Connect (AIDL-backed, reflected record/permission types) ---
-keep class androidx.health.connect.client.** { *; }
-keep class androidx.health.platform.client.** { *; }
-dontwarn androidx.health.**

# --- WorkManager instantiates workers by class name ---
-keep class * extends androidx.work.ListenableWorker { public <init>(...); }
-keep class com.pulsenx.bridge.HealthSyncWorker { *; }

# --- App entry points referenced from the manifest ---
-keep class com.pulsenx.bridge.MainActivity { *; }
-keep class com.pulsenx.bridge.VitalsBridgeService { *; }
-keep class com.pulsenx.bridge.BootReceiver { *; }
