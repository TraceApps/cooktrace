package com.cooktrace.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The cook timers, rung by the phone itself (#77).
 *
 * The app's own countdown lives in a WebView, and Android stops a WebView's
 * JavaScript soon after the screen locks or the app goes to the background,
 * which is exactly when a cook walks away from the pan. So the app hands every
 * running timer to this, and this rings it: an exact alarm at each timer's end
 * that posts a "Timer done" on an alarm channel, sounding until it is stopped,
 * through the lock screen and with the app long gone.
 *
 * While a timer counts, an ongoing notification shows it (Android draws the
 * countdown, so it is right with the app gone), with +1 Min and Stop. Those
 * buttons act here without opening the app; the app reads the list back when
 * it next runs (KitchenTimersPlugin), and while it runs it hears at once.
 *
 * Local-only: a watch that is handed a cook runs the same timers on its own
 * and buzzes itself, and a copy mirrored from the phone would be a second
 * buzz for the same pan.
 */
final class KitchenTimers {
    private static final String TAG = "KitchenTimers";
    private static final String PREFS = "cooktrace.kitchen_timers";

    static final String CHANNEL_COUNT = "cook-timers";
    static final String CHANNEL_RING = "cook-timer-alarms";
    /** One notification per timer: this id, tagged with the timer's. */
    static final int NOTE_ID = 7700;
    private static final int RC_OPEN = 7701;

    static final String ACTION_END = "com.cooktrace.app.TIMER_END";
    static final String ACTION_ADD = "com.cooktrace.app.TIMER_ADD";
    static final String ACTION_STOP = "com.cooktrace.app.TIMER_STOP";

    /** The app, while it runs, hears about changes made here. */
    interface Listener { void changed(List<KitchenTimer> list, long at); }
    static volatile Listener listener;

    private static final Handler main = new Handler(Looper.getMainLooper());

    private KitchenTimers() {}

    // ── The list ─────────────────────────────────────────────────────────

    static synchronized List<KitchenTimer> load(Context ctx) {
        List<KitchenTimer> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(ctx).getString("timers", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null || o.optString("id", "").isEmpty()) continue;
                out.add(new KitchenTimer(o.optString("id"), o.optString("label"),
                    o.optString("recipe"), o.optLong("endsAt"), o.optInt("total")));
            }
        } catch (Exception e) {
            Log.w(TAG, "couldn't read the timers: " + e.getMessage());
        }
        return out;
    }

    /** When the list last changed, by the app or by a button here. */
    static synchronized long stamp(Context ctx) {
        return prefs(ctx).getLong("at", 0L);
    }

    private static synchronized void save(Context ctx, List<KitchenTimer> list, long at) {
        JSONArray arr = new JSONArray();
        try {
            for (KitchenTimer t : list) {
                JSONObject o = new JSONObject();
                o.put("id", t.id);
                o.put("label", t.label);
                o.put("recipe", t.recipe);
                o.put("endsAt", t.endsAt);
                o.put("total", t.total);
                arr.put(o);
            }
        } catch (Exception e) {
            Log.w(TAG, "couldn't keep the timers: " + e.getMessage());
        }
        prefs(ctx).edit().putString("timers", arr.toString()).putLong("at", at).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── Words, from the app's own translations ───────────────────────────

    /**
     * What the notifications say, in the app's language. The receiver that
     * acts on a button has no web layer to ask, so the app sends them along.
     */
    static void keepWords(Context ctx, JSONObject words) {
        if (words == null) return;
        prefs(ctx).edit().putString("words", words.toString()).apply();
    }

    private static String word(Context ctx, String key, String fallback) {
        try {
            String v = new JSONObject(prefs(ctx).getString("words", "{}")).optString(key, "");
            return v.isEmpty() ? fallback : v;
        } catch (Exception e) {
            return fallback;
        }
    }

    // ── Changes ──────────────────────────────────────────────────────────

    /** The app's list, now the list: what changed is armed, posted or taken down. */
    static synchronized void fromApp(Context ctx, List<KitchenTimer> list) {
        List<KitchenTimer> before = load(ctx);
        save(ctx, list, System.currentTimeMillis());
        apply(ctx, before, list);
    }

    /** A button on a notification. */
    static synchronized void act(Context ctx, String action, String id) {
        List<KitchenTimer> before = load(ctx);
        if (KitchenTimer.find(before, id) == null) {
            // Already gone (stopped in the app a moment ago): nothing of it
            // should be left showing.
            cancelEnd(ctx, id);
            cancelNote(ctx, id);
            return;
        }
        long now = System.currentTimeMillis();
        List<KitchenTimer> after = ACTION_ADD.equals(action)
            ? KitchenTimer.extend(before, id, 60, now)
            : KitchenTimer.without(before, id);
        save(ctx, after, now);
        apply(ctx, before, after);
        Listener l = listener;
        if (l != null) main.post(() -> { try { l.changed(after, now); } catch (Exception ignored) {} });
    }

    /**
     * Every timer still counting, armed and shown again. A reboot, a
     * force-stop and an app update take an app's alarms with them while its
     * list stays, and a countdown can't be shown until notifications are
     * allowed; without this, such a timer would count on screen and end in
     * silence.
     */
    static synchronized void rearm(Context ctx) {
        long now = System.currentTimeMillis();
        for (KitchenTimer t : load(ctx)) {
            if (t.rang(now)) continue;
            armEnd(ctx, t);
            showCounting(ctx, t);
        }
    }

    /** A timer's end: it rings, unless it was stopped or moved since. */
    static synchronized void atEnd(Context ctx, String id) {
        KitchenTimer t = KitchenTimer.find(load(ctx), id);
        if (t == null || !t.rang(System.currentTimeMillis() + 1500L)) return;
        ring(ctx, t);
    }

    private static void apply(Context ctx, List<KitchenTimer> before, List<KitchenTimer> after) {
        long now = System.currentTimeMillis();
        for (String id : KitchenTimer.gone(before, after)) {
            cancelEnd(ctx, id);
            cancelNote(ctx, id);
        }
        for (KitchenTimer t : KitchenTimer.changed(before, after)) {
            if (!t.rang(now)) {
                // Counting (again, after +1 Min on one that rang): the alarm
                // at its new end, and the countdown in place of the ringing,
                // which is taken down first so its sound stops with it.
                KitchenTimer was = KitchenTimer.find(before, t.id);
                if (was != null && was.rang(now)) cancelNote(ctx, t.id);
                armEnd(ctx, t);
                showCounting(ctx, t);
            } else if (now - t.endsAt < 60_000L) {
                // Over before this side heard of it (ended while the app was
                // being reopened): rung now. One over for longer is already
                // showing as done in the app, and a late ring would only
                // startle.
                ring(ctx, t);
            }
        }
    }

    // ── The notifications ────────────────────────────────────────────────

    private static void showCounting(Context ctx, KitchenTimer t) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return;
        channels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_COUNT)
            .setSmallIcon(R.drawable.ic_stat_timer)
            .setContentTitle(t.label.isEmpty() ? word(ctx, "timer", "Timer") : t.label)
            .setContentText(t.recipe)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setWhen(t.endsAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setContentIntent(open(ctx))
            .addAction(0, word(ctx, "add", "+1 Min"), button(ctx, ACTION_ADD, t.id))
            .addAction(0, word(ctx, "stop", "Stop"), button(ctx, ACTION_STOP, t.id))
            // In the status bar as well as the shade on Android 16 and later,
            // where the system allows it.
            .setRequestPromotedOngoing(true);
        post(ctx, t.id, b.build());
    }

    private static void ring(Context ctx, KitchenTimer t) {
        if (!canNotify(ctx)) {
            // Notifications turned off for the app, or its alarms: nowhere to
            // show it, but the timer still sounds once rather than not at all.
            soundOnce(ctx);
            return;
        }
        channels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_RING)
            .setSmallIcon(R.drawable.ic_stat_timer)
            .setContentTitle(word(ctx, "done", "Timer Done"))
            .setContentText(t.line())
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setLocalOnly(true)
            .setWhen(t.endsAt)
            .setShowWhen(true)
            .setContentIntent(open(ctx))
            // Swiped away is answered, as Stop is.
            .setDeleteIntent(button(ctx, ACTION_STOP, t.id))
            .addAction(0, word(ctx, "add", "+1 Min"), button(ctx, ACTION_ADD, t.id))
            .addAction(0, word(ctx, "stop", "Stop"), button(ctx, ACTION_STOP, t.id));
        Notification n = b.build();
        // Sounding until it is answered, as a kitchen timer does, not one
        // chime that is easy to miss over a running tap.
        n.flags |= Notification.FLAG_INSISTENT;
        post(ctx, t.id, n);
    }

    private static void post(Context ctx, String id, Notification n) {
        try {
            NotificationManagerCompat.from(ctx).notify(id, NOTE_ID, n);
        } catch (SecurityException e) {
            Log.w(TAG, "not allowed to post a timer: " + e.getMessage());
        } catch (Exception e) {
            Log.w(TAG, "couldn't post a timer: " + e.getMessage());
        }
    }

    static void cancelNote(Context ctx, String id) {
        try { NotificationManagerCompat.from(ctx).cancel(id, NOTE_ID); } catch (Exception ignored) {}
    }

    /**
     * Two channels, so each can be set apart in Android's settings: the
     * countdown is silent, and the alarm sounds as an alarm, the phone's own
     * alarm sound unless it is changed there. Made again with every list from
     * the app, which only renames them into the app's language.
     */
    private static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel count = new NotificationChannel(
            CHANNEL_COUNT, word(ctx, "channel", "Cook Timers"), NotificationManager.IMPORTANCE_LOW);
        count.setSound(null, null);
        count.enableVibration(false);
        count.setShowBadge(false);
        nm.createNotificationChannel(count);

        NotificationChannel ring = new NotificationChannel(
            CHANNEL_RING, word(ctx, "alarm_channel", "Timer Alarms"), NotificationManager.IMPORTANCE_HIGH);
        ring.setSound(alarmSound(), new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        ring.enableVibration(true);
        ring.setVibrationPattern(new long[] { 0, 400, 200, 400 });
        ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ring);
    }

    private static Uri alarmSound() {
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        return uri != null ? uri : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
    }

    /** The alarm sound for a few seconds, and a buzz, with no notification to carry them. */
    private static void soundOnce(Context ctx) {
        try {
            Ringtone r = RingtoneManager.getRingtone(ctx, alarmSound());
            if (r != null) {
                r.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
                r.play();
                main.postDelayed(() -> { try { r.stop(); } catch (Exception ignored) {} }, 6000L);
            }
        } catch (Exception e) {
            Log.w(TAG, "couldn't sound a timer: " + e.getMessage());
        }
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createWaveform(new long[] { 0, 400, 200, 400, 200, 400 }, -1));
            }
        } catch (Exception ignored) {}
    }

    private static PendingIntent open(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, RC_OPEN, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * A button, or the end alarm, for one timer. The timer's id is in the
     * action itself: two intents that differ only in their extras are the
     * same PendingIntent to Android, and one timer's Stop would stop another.
     */
    private static PendingIntent button(Context ctx, String action, String id) {
        Intent i = new Intent(ctx, KitchenTimerReceiver.class).setAction(action + ":" + id);
        return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ── The alarm at each end ────────────────────────────────────────────

    /**
     * Exact, and through Doze: an egg needs its four minutes, not five. Where
     * exact alarms are not allowed, a near one is still better than none.
     */
    private static void armEnd(Context ctx, KitchenTimer t) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = button(ctx, ACTION_END, t.id);
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.endsAt, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.endsAt, pi);
            }
        } catch (Exception e) {
            try { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.endsAt, pi); } catch (Exception ignored) {}
        }
    }

    private static void cancelEnd(Context ctx, String id) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(ctx, KitchenTimerReceiver.class).setAction(ACTION_END + ":" + id);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (pi != null) { am.cancel(pi); pi.cancel(); }
    }

    // ── For the app ──────────────────────────────────────────────────────

    static JSONArray toJson(List<KitchenTimer> list) {
        JSONArray arr = new JSONArray();
        for (KitchenTimer t : list) {
            try {
                JSONObject o = new JSONObject();
                o.put("id", t.id);
                o.put("label", t.label);
                o.put("recipe", t.recipe);
                o.put("endsAt", t.endsAt);
                o.put("total", t.total);
                arr.put(o);
            } catch (Exception ignored) {}
        }
        return arr;
    }

    /** Can "Timer Done" be heard: notifications allowed, and its channel not turned off. */
    static boolean canNotify(Context ctx) {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ring = nm == null ? null : nm.getNotificationChannel(CHANNEL_RING);
        return ring == null || ring.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
}
