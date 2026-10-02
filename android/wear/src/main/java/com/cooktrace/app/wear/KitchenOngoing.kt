package com.cooktrace.app.wear

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status

/**
 * The timer on the watch face and in the launcher while it counts, without
 * the app open.
 *
 * The reason a timer is on a wrist is that you walked away from it, so it has
 * to be readable without going back to the app that set it. This posts one
 * ongoing notification and hangs an ongoing activity off it, which is what
 * the watch face and the launcher read.
 *
 * Nothing here wakes up to tick. The notification carries a deadline and the
 * system draws the counting, exactly as the alarms carry a deadline rather
 * than a countdown: it is posted when a timer starts, changes or ends, and at
 * no other time. Updating the text ourselves every second is how a watch app
 * eats a battery, and it would buy nothing.
 *
 * One entry, not one per timer. A face has room for a single mark and the
 * soonest is the one about to want you, which is the same rule the ring on
 * the timers screen already follows; the others are counted in the title.
 */
object KitchenOngoing {

    private const val CHANNEL = "timers"
    private const val NOTE_ID = 4200
    private const val RANG_ID = 4201

    /**
     * Post, update or take down the entry, from whatever the saved timers now
     * say. Called where the timers change, never on a tick.
     */
    fun refresh(ctx: Context) {
        val now = System.currentTimeMillis()
        val live = Pairing.timers(ctx).filterNot { it.done(now) }.sortedBy { it.endsAt }
        val soonest = live.firstOrNull()
        if (soonest == null) {
            hide(ctx)
            return
        }
        // Notifications turned off for the app: the timer still runs and still
        // buzzes, there is simply nowhere to show it.
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return

        channel(ctx)
        val label = soonest.label.ifBlank { "Timer" }
        val title = label + if (live.size > 1) " and ${live.size - 1} more" else ""
        val builder = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_timer)
            .setContentTitle(title)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setOngoing(true)
            // The buzz at the end is the alarm's job, and it is a proper
            // alarm; this is only something to look at.
            .setSilent(true)
            .setOnlyAlertOnce(true)
            // The stream card counts down by itself, in wall-clock time.
            .setWhen(soonest.endsAt)
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setContentIntent(open(ctx))

        // The face reads the ongoing activity rather than the card, and its
        // clock runs on time since boot, not on the wall.
        val zero = SystemClock.elapsedRealtime() + (soonest.endsAt - now)
        val status = Status.Builder()
            .addTemplate("#timer# · #label#")
            .addTemplate("#timer#")
            .addPart("timer", Status.TimerPart(zero))
            .addPart("label", Status.TextPart(title))
            .build()

        runCatching {
            OngoingActivity.Builder(ctx, CHANNEL, NOTE_ID, builder)
                .setStaticIcon(R.drawable.ic_timer)
                .setTouchIntent(open(ctx))
                .setStatus(status)
                .setTitle(title)
                .build()
                .apply(ctx)
            NotificationManagerCompat.from(ctx).notify(NOTE_ID, builder.build())
        }
    }

    fun hide(ctx: Context) {
        runCatching { NotificationManagerCompat.from(ctx).cancel(NOTE_ID) }
    }

    /**
     * It rang. The buzz on its own says something happened but not what, and
     * a watch buzzes for plenty of reasons, so this is what is left on screen
     * to answer that: which app, which dish, and a way back in.
     *
     * Silent, because the alarm has already done the buzzing as a proper
     * alarm; this is only the words.
     */
    fun rang(ctx: Context, label: String) {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
        channel(ctx)
        val what = label.ifBlank { "Timer" }
        val note = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_timer)
            .setContentTitle("$what is done")
            .setContentText("Your CookTrace timer has finished.")
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setSilent(true)
            .setAutoCancel(true)
            .setContentIntent(open(ctx))
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(RANG_ID, note) }
    }

    /** Tapping it goes to the timers, not to the shopping list. */
    private fun open(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx,
        NOTE_ID,
        Intent(ctx, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_ROUTE, "timers"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun channel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Timers", NotificationManager.IMPORTANCE_LOW).apply {
                description = "What is counting down in the kitchen"
                setShowBadge(false)
                enableVibration(false)
            }
        )
    }
}
