package com.cooktrace.app.wear

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * The buzz at the end of a kitchen timer, set to happen whether or not the
 * app is still in front of you.
 *
 * A watch goes back to its face the moment your wrist drops, and an app that
 * is no longer on screen is not a reliable place to count from: the whole
 * point of a timer on a wrist is that you can walk away from it. So the
 * countdown on screen is only the picture, and this is what actually rings.
 *
 * A kitchen runs several at once, a pan and an oven, so each one carries its
 * own request code rather than sharing one.
 */
object KitchenAlarm {

    private const val ACTION = "com.cooktrace.app.wear.TIMER_OVER"
    private const val REQUEST = 4100

    fun schedule(ctx: Context, id: Int, endsAt: Long) {
        if (endsAt <= System.currentTimeMillis()) return
        val alarms = ctx.getSystemService(AlarmManager::class.java) ?: return
        val intent = pending(ctx, id)
        runCatching {
            // Exact, and awake through idle: two minutes for an egg, and a
            // minute of drift makes it useless.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endsAt, intent)
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endsAt, intent)
            }
        }.onFailure {
            // Exact alarms turned off for this app: an approximate buzz is
            // still better than none, and the screen keeps the real count.
            runCatching { alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endsAt, intent) }
        }
    }

    fun cancel(ctx: Context, id: Int) {
        val alarms = ctx.getSystemService(AlarmManager::class.java) ?: return
        runCatching { alarms.cancel(pending(ctx, id)) }
    }

    private fun pending(ctx: Context, id: Int): PendingIntent = PendingIntent.getBroadcast(
        ctx,
        REQUEST + id,
        // The action carries the id too: two PendingIntents that differ only
        // by request code are still "the same" to some launchers.
        Intent(ctx, KitchenAlarmReceiver::class.java).setAction("$ACTION.$id"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** Two short buzzes, which a sleeve does not hide. */
    fun buzz(ctx: Context) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            ctx.getSystemService(Vibrator::class.java)
        } ?: return
        // As an alarm, so it is not swallowed by whatever else the watch is
        // doing at the time.
        val effect = VibrationEffect.createWaveform(longArrayOf(0, 250, 150, 250), -1)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(
                    effect,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            }
        }
    }
}

class KitchenAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // The one that rang comes off the list; the others carry on, because
        // a kitchen runs a pan and an oven at the same time.
        val now = System.currentTimeMillis()
        val live = Pairing.timers(context).filterNot { it.done(now) }
        if (live.size != Pairing.timers(context).size) Pairing.putTimers(context, live)
        KitchenTileService.refresh(context)
        // The one that rang comes off the face too, and what is left carries
        // on counting there.
        KitchenOngoing.refresh(context)
        KitchenAlarm.buzz(context)
    }
}
