package com.workoutmaker.app.util

import android.content.Context
import android.util.Log
import com.workoutmaker.app.BuildConfig
import java.io.File
import java.time.Instant

/**
 * Thin wrapper over [Log], debug-gated for logcat but always writing to a
 * bounded local file so the athlete has something to export/send even from a
 * release build ("send debug logs to developer" is opt-in and reads this file).
 *
 * Everything logs under one tag family ("WM") so the whole app's chatter can be
 * filtered with a single grep — `scripts/dev.sh android:log` keys off it. Calls
 * no-op on logcat in release builds (BuildConfig.DEBUG == false), so it's safe
 * to leave in hot paths. The `area` is a short subsystem label, e.g.
 * AppLog.i("gen", ...).
 */
object AppLog {
    private const val TAG = "WM"
    private const val FILE_NAME = "debug_log.txt"
    // Trimmed back to half whenever it grows past this, so disk use stays flat
    // regardless of how long the app has been installed.
    private const val MAX_FILE_BYTES = 512 * 1024

    @Volatile private var logFile: File? = null

    /** Call once from Application.onCreate, before any other AppLog use. */
    fun install(context: Context) {
        logFile = File(context.applicationContext.filesDir, FILE_NAME)
    }

    /** The local log file, or null if [install] was never called. */
    fun file(): File? = logFile?.also { f -> runCatching { synchronized(this) { if (f.exists()) f.writeText(redactLog(f.readText())) } } }

    fun d(area: String, msg: String) = write("D", area, msg)
    fun i(area: String, msg: String) = write("I", area, msg)
    fun w(area: String, msg: String, t: Throwable? = null) = write("W", area, msg, t)
    fun e(area: String, msg: String, t: Throwable? = null) = write("E", area, msg, t)
    private fun write(level: String, area: String, msg: String, t: Throwable? = null) {
        val safe = redactLog(msg + (t?.let { " :: " + it.stackTraceToString() } ?: ""))
        if (BuildConfig.DEBUG) Log.println(when(level) { "E" -> Log.ERROR; "W" -> Log.WARN; "D" -> Log.DEBUG; else -> Log.INFO }, TAG, "[$area] $safe")
        append(level, area, safe.take(4000))
    }

    @Synchronized
    private fun append(level: String, area: String, msg: String, t: Throwable? = null) {
        val f = logFile ?: return
        runCatching {
            if (f.length() > MAX_FILE_BYTES) f.writeText(f.readText().takeLast(MAX_FILE_BYTES / 2))
            val line = buildString {
                append(Instant.now()).append(' ').append(level).append(" [").append(area).append("] ").append(msg)
                if (t != null) append(" :: ").append(t.stackTraceToString().take(2_000))
                append('\n')
            }
            f.appendText(line)
        }
    }

    /**
     * Run [block], logging its elapsed wall-clock ms and ok/failed outcome.
     * Inlined so it threads through `suspend` call sites (network/LLM latency).
     */
    inline fun <T> time(area: String, label: String, block: () -> T): T {
        val started = System.currentTimeMillis()
        try {
            val r = block()
            i(area, "$label ok ${System.currentTimeMillis() - started}ms")
            return r
        } catch (t: Throwable) {
            e(area, "$label failed ${System.currentTimeMillis() - started}ms: ${t.message}", t)
            throw t
        }
    }
}
