package com.workoutmaker.app.calendar

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import com.workoutmaker.app.data.BusyDay
import dagger.hilt.android.qualifiers.ApplicationContext
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import javax.inject.Inject
import javax.inject.Singleton
import android.net.Uri

// Device-calendar bridge (CalendarProvider, NOT the Google Calendar API — every
// synced account, no OAuth, works offline). Two one-way flows, both opt-in:
//  - READ: events → per-day busy windows ("18:00-20:30"), passed to the planner
//    so it schedules around life. Titles never leave the phone.
//  - WRITE: planned workouts → all-day events. Deliberately all-day: the app
//    prescribes WHAT, not WHEN — an invented clock time would fire wrong-time
//    reminders, fake conflicts, and get read back as a busy block by this very
//    class. MARKER in the description tags our events so reads skip them and
//    re-syncs replace them.
@Singleton
class DeviceCalendarManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        const val MARKER = "[Workout Maker]"

        // Our own local calendar: workouts land in a clearly-named "Workout
        // Maker" calendar the user can hide/colour/delete as one unit, instead
        // of interleaving with their personal events. ACCOUNT_TYPE_LOCAL means
        // it lives only on this device and never syncs anywhere.
        const val CALENDAR_NAME = "Workout Maker"
        private const val CALENDAR_COLOR = 0xFF7D9070.toInt() // brand sage
    }

    fun hasReadPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED

    fun hasWritePermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED

    // ---- READ: busy windows -------------------------------------------------

    /** Per-day busy summary for [days] days starting at [from]. Never throws. */
    fun busyDays(from: LocalDate, days: Int): List<BusyDay> {
        if (!hasReadPermission()) return emptyList()
        val zone = ZoneId.systemDefault()
        val rangeStart = from.atStartOfDay(zone).toInstant().toEpochMilli()
        val rangeEnd = from.plusDays(days.toLong()).atStartOfDay(zone).toInstant().toEpochMilli()

        val slots = mutableListOf<BusySlot>()
        runCatching {
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
                .appendPath(rangeStart.toString())
                .appendPath(rangeEnd.toString())
                .build()
            val proj = arrayOf(
                CalendarContract.Instances.BEGIN,
                CalendarContract.Instances.END,
                CalendarContract.Instances.ALL_DAY,
                CalendarContract.Instances.DESCRIPTION,
                CalendarContract.Instances.AVAILABILITY,
                CalendarContract.Instances.SELF_ATTENDEE_STATUS,
            )
            context.contentResolver.query(uri, proj, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    // Skip: our own workout events, events marked "free", declined invites.
                    if ((c.getString(3) ?: "").contains(MARKER)) continue
                    if (c.getInt(4) == CalendarContract.Events.AVAILABILITY_FREE) continue
                    if (c.getInt(5) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue
                    slots += BusySlot(c.getLong(0), c.getLong(1), c.getInt(2) == 1)
                }
            }
        }
        return busyDaysFromSlots(slots, from, days, zone)
    }

    // ---- WRITE: planned workouts as all-day events --------------------------

    data class PlanEntry(val date: String, val title: String, val detail: String, val startMinute: Int? = null, val durationMinutes: Double = 0.0)

    /**
     * Replace our events in [from, from+days) with [entries]. Delete-then-insert
     * keyed on MARKER keeps re-plans idempotent. Never throws.
     */
    fun syncPlan(entries: List<PlanEntry>, from: LocalDate, days: Int) {
        if (!hasWritePermission()) return
        val calId = ensureAppCalendar() ?: writableCalendarId() ?: return
        runCatching {
            val startUtc = minOf(from.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(), from.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli())
            val endUtc = maxOf(from.plusDays(days.toLong()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(), from.plusDays(days.toLong()).atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli())
            // Delete across ALL calendars (not just ours): earlier builds wrote
            // MARKER events into the primary calendar, and this migrates them
            // into the app calendar on the next re-sync.
            context.contentResolver.delete(
                CalendarContract.Events.CONTENT_URI,
                "${CalendarContract.Events.DESCRIPTION} LIKE ? AND " +
                    "${CalendarContract.Events.DTSTART} >= ? AND ${CalendarContract.Events.DTSTART} < ?",
                arrayOf("%$MARKER%", startUtc.toString(), endUtc.toString()),
            )
            for (e in entries) {
                val date = runCatching { LocalDate.parse(e.date) }.getOrNull() ?: continue
                if (date < from || date >= from.plusDays(days.toLong())) continue
                val timed = e.startMinute != null && e.durationMinutes > 0
                val zone = java.time.ZoneId.systemDefault()
                val dayUtc = if (timed) date.atTime(e.startMinute!! / 60, e.startMinute % 60).atZone(zone).toInstant().toEpochMilli() else date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
                context.contentResolver.insert(
                    CalendarContract.Events.CONTENT_URI,
                    ContentValues().apply {
                        put(CalendarContract.Events.CALENDAR_ID, calId)
                        put(CalendarContract.Events.TITLE, e.title)
                        put(CalendarContract.Events.DESCRIPTION, "${e.detail}\n\n$MARKER")
                        put(CalendarContract.Events.DTSTART, dayUtc)
                        put(CalendarContract.Events.DTEND, dayUtc + if (timed) (e.durationMinutes * 60_000).toLong() else 86_400_000L)
                        put(CalendarContract.Events.ALL_DAY, if (timed) 0 else 1)
                        put(CalendarContract.Events.EVENT_TIMEZONE, if (timed) zone.id else "UTC")
                        // A workout is a to-do on the day banner, not a busy slot:
                        // it must never block the busy-signal reading above.
                        put(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_FREE)
                        put(CalendarContract.Events.HAS_ALARM, 0)
                    },
                )
            }
        }
    }

    /** Remove every event we ever wrote (the write toggle was switched off). */
    fun clearAll() {
        if (!hasWritePermission()) return
        runCatching {
            // Legacy MARKER events in other calendars first, then our whole
            // calendar in one go (deleting the calendar removes its events).
            context.contentResolver.delete(
                CalendarContract.Events.CONTENT_URI,
                "${CalendarContract.Events.DESCRIPTION} LIKE ?",
                arrayOf("%$MARKER%"),
            )
            appCalendarId()?.let { id ->
                context.contentResolver.delete(
                    asSyncAdapter(CalendarContract.Calendars.CONTENT_URI),
                    "${CalendarContract.Calendars._ID} = ?",
                    arrayOf(id.toString()),
                )
            }
        }
    }

    // ---- The app's own calendar ---------------------------------------------

    // Calendar writes/deletes require sync-adapter caller params for a local
    // account; this stamps them onto a CalendarContract uri.
    private fun asSyncAdapter(uri: Uri): Uri = uri.buildUpon()
        .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
        .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, CALENDAR_NAME)
        .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
        .build()

    private fun appCalendarId(): Long? = runCatching {
        context.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID),
            "${CalendarContract.Calendars.ACCOUNT_TYPE} = ? AND ${CalendarContract.Calendars.ACCOUNT_NAME} = ?",
            arrayOf(CalendarContract.ACCOUNT_TYPE_LOCAL, CALENDAR_NAME),
            null,
        )?.use { c -> if (c.moveToFirst()) c.getLong(0) else null }
    }.getOrNull()

    /** The app's own "Workout Maker" calendar, created on first use. */
    private fun ensureAppCalendar(): Long? = runCatching {
        appCalendarId() ?: run {
            val values = ContentValues().apply {
                put(CalendarContract.Calendars.ACCOUNT_NAME, CALENDAR_NAME)
                put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
                put(CalendarContract.Calendars.NAME, CALENDAR_NAME)
                put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CALENDAR_NAME)
                put(CalendarContract.Calendars.CALENDAR_COLOR, CALENDAR_COLOR)
                put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER)
                put(CalendarContract.Calendars.OWNER_ACCOUNT, CALENDAR_NAME)
                put(CalendarContract.Calendars.VISIBLE, 1)
                put(CalendarContract.Calendars.SYNC_EVENTS, 1)
            }
            context.contentResolver.insert(asSyncAdapter(CalendarContract.Calendars.CONTENT_URI), values)
                ?.lastPathSegment?.toLongOrNull()
        }
    }.getOrNull()

    // The user's primary writable calendar, else the first writable one.
    // Fallback only: used when creating the app calendar fails.
    private fun writableCalendarId(): Long? = runCatching {
        val proj = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.IS_PRIMARY,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
        )
        var primary: Long? = null
        var first: Long? = null
        context.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI, proj,
            "${CalendarContract.Calendars.VISIBLE} = 1", null, null,
        )?.use { c ->
            while (c.moveToNext()) {
                if (c.getInt(2) < CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) continue
                if (first == null) first = c.getLong(0)
                if (c.getInt(1) == 1 && primary == null) primary = c.getLong(0)
            }
        }
        primary ?: first
    }.getOrNull()
}

// Extracted pure so JVM tests can cover the tricky bits (UTC-anchored all-day
// events, midnight-spanning timed events, range clamping).
internal data class BusySlot(val beginMs: Long, val endMs: Long, val allDay: Boolean)

internal fun busyDaysFromSlots(
    slots: List<BusySlot>,
    from: LocalDate,
    days: Int,
    zone: ZoneId,
): List<BusyDay> {
    val windowsByDate = mutableMapOf<LocalDate, MutableList<String>>()
    val allDayDates = mutableSetOf<LocalDate>()
    val lastDay = from.plusDays(days.toLong() - 1)
    val hhmm = { t: LocalTime -> "%02d:%02d".format(t.hour, t.minute) }
    for (s in slots) {
        if (s.allDay) {
            // All-day instances are anchored to UTC midnights by contract.
            var d = Instant.ofEpochMilli(s.beginMs).atZone(ZoneOffset.UTC).toLocalDate()
            val end = Instant.ofEpochMilli(s.endMs).atZone(ZoneOffset.UTC).toLocalDate()
            while (d < end) {
                if (d in from..lastDay) allDayDates += d
                d = d.plusDays(1)
            }
            continue
        }
        // Timed events: clamp to each local day they touch.
        var begin = Instant.ofEpochMilli(s.beginMs).atZone(zone)
        val end = Instant.ofEpochMilli(s.endMs).atZone(zone)
        while (begin < end) {
            val dayEnd = begin.toLocalDate().plusDays(1).atStartOfDay(zone)
            val sliceEnd = if (end < dayEnd) end else dayEnd
            val d = begin.toLocalDate()
            if (d in from..lastDay && begin < sliceEnd) {
                val endTime = if (sliceEnd == dayEnd) LocalTime.of(23, 59) else sliceEnd.toLocalTime()
                if (begin.toLocalTime() != endTime) {
                    windowsByDate.getOrPut(d) { mutableListOf() } +=
                        "${hhmm(begin.toLocalTime())}-${hhmm(endTime)}"
                }
            }
            begin = dayEnd
        }
    }

    return (windowsByDate.keys + allDayDates).sorted().map { d ->
        BusyDay(
            date = d.toString(),
            windows = windowsByDate[d].orEmpty().sorted(),
            all_day = d in allDayDates,
        )
    }
}
