package com.cooktrace.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * A cook timer's end, and its notification's +1 Min and Stop (KitchenTimers).
 * Not exported: only this app's own PendingIntents reach it, and the system's
 * boot and app-updated broadcasts, after which the timers are armed again.
 * A timer's id is the part of the action after the colon.
 */
public class KitchenTimerReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            // Both take the app's alarms with them; the timers are still due.
            KitchenTimers.rearm(context.getApplicationContext());
            return;
        }
        int colon = action.indexOf(':');
        if (colon <= 0 || colon == action.length() - 1) return;
        String kind = action.substring(0, colon);
        String id = action.substring(colon + 1);
        Context ctx = context.getApplicationContext();
        switch (kind) {
            case KitchenTimers.ACTION_END:
                KitchenTimers.atEnd(ctx, id);
                return;
            case KitchenTimers.ACTION_ADD:
            case KitchenTimers.ACTION_STOP:
                KitchenTimers.act(ctx, kind, id);
                return;
            default:
        }
    }
}
