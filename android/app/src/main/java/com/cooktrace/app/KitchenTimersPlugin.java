package com.cooktrace.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The app's side of the phone-rung cook timers (KitchenTimers, #77): the app
 * hands over what is counting, and reads back what a notification's +1 Min or
 * Stop changed while it was not looking (src/lib/native-timers.js).
 *
 * Whichever said something last is right. Each change is stamped, and a list
 * from the app that has not seen the latest change made here is answered with
 * that change instead of being taken, so a Stop pressed on the lock screen is
 * not undone by the app catching up.
 */
@CapacitorPlugin(name = "KitchenTimers")
public class KitchenTimersPlugin extends Plugin {

    @Override
    public void load() {
        KitchenTimers.listener = (list, at) -> notifyListeners("changed", state(list, at));
        // A new process: after a force-stop the alarms are gone though the
        // timers are still due.
        KitchenTimers.rearm(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        KitchenTimers.listener = null;
    }

    /** The app's timers, as of the change stamped `since` that it last saw. */
    @PluginMethod
    public void sync(PluginCall call) {
        android.content.Context ctx = getContext();
        KitchenTimers.keepWords(ctx, call.getObject("words"));
        Object raw = call.getData().opt("since");
        long since = raw instanceof Number ? ((Number) raw).longValue() : 0L;
        JSObject ret;
        synchronized (KitchenTimers.class) {
            long at = KitchenTimers.stamp(ctx);
            if (at > since) {
                // Changed here since the app last looked: it hears that first.
                ret = state(KitchenTimers.load(ctx), at);
                ret.put("taken", false);
            } else {
                KitchenTimers.fromApp(ctx, parse(call.getData().optJSONArray("timers")));
                ret = state(KitchenTimers.load(ctx), KitchenTimers.stamp(ctx));
                ret.put("taken", true);
            }
        }
        call.resolve(ret);
    }

    /** Notifications were just allowed: the countdowns can be shown now. */
    @PluginMethod
    public void rearm(PluginCall call) {
        android.content.Context ctx = getContext();
        KitchenTimers.rearm(ctx);
        call.resolve(state(KitchenTimers.load(ctx), KitchenTimers.stamp(ctx)));
    }

    /** What is counting, as this side has it. */
    @PluginMethod
    public void read(PluginCall call) {
        android.content.Context ctx = getContext();
        call.resolve(state(KitchenTimers.load(ctx), KitchenTimers.stamp(ctx)));
    }

    private JSObject state(List<KitchenTimer> list, long at) {
        JSObject ret = new JSObject();
        ret.put("timers", KitchenTimers.toJson(list));
        ret.put("at", at);
        // Notifications turned off: the app then rings timers itself when it
        // can, since there is nowhere here to ring them for more than a moment.
        ret.put("notify", KitchenTimers.canNotify(getContext()));
        return ret;
    }

    private static List<KitchenTimer> parse(JSONArray arr) {
        List<KitchenTimer> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            Object end = o.opt("endsAt");
            long endsAt = end instanceof Number ? ((Number) end).longValue() : 0L;
            if (id.isEmpty() || endsAt <= 0) continue;
            out.add(new KitchenTimer(id, o.optString("label", ""), o.optString("recipe", ""),
                endsAt, o.optInt("total", 0)));
        }
        return out;
    }
}
