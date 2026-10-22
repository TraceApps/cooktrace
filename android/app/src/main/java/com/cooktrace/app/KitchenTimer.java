package com.cooktrace.app;

import java.util.ArrayList;
import java.util.List;

/**
 * A cook timer as the phone's native side holds it, and the decisions about a
 * list of them that need no Android: what +1 Min and Stop do, and what changed
 * between two lists, so only those alarms and notifications are touched.
 *
 * Plain Java, so it is tested on its own (KitchenTimerTest). KitchenTimers
 * does the Android half: keeping the list, the alarms, the notifications.
 *
 * A timer is a deadline. One whose deadline has passed has rung, and stays
 * on the list, ringing, until it is stopped or given another minute.
 */
public final class KitchenTimer {

    public String id = "";
    public String label = "";
    /** The recipe it is for, when it is for one. */
    public String recipe = "";
    public long endsAt;
    /** Seconds the whole timer is, +1 Min included. */
    public int total;

    public KitchenTimer() {}

    public KitchenTimer(String id, String label, String recipe, long endsAt, int total) {
        this.id = id == null ? "" : id;
        this.label = label == null ? "" : label;
        this.recipe = recipe == null ? "" : recipe;
        this.endsAt = endsAt;
        this.total = total;
    }

    public boolean rang(long now) {
        return endsAt <= now;
    }

    public KitchenTimer copy() {
        return new KitchenTimer(id, label, recipe, endsAt, total);
    }

    /** Shows and rings the same: nothing to redo for it. */
    public boolean sameAs(KitchenTimer o) {
        return o != null && id.equals(o.id) && endsAt == o.endsAt
            && label.equals(o.label) && recipe.equals(o.recipe);
    }

    public static KitchenTimer find(List<KitchenTimer> list, String id) {
        for (KitchenTimer t : list) if (t.id.equals(id)) return t;
        return null;
    }

    /**
     * +1 Min: a minute more on one that is counting, and a minute from now on
     * one that has rung, which counts again.
     */
    public static List<KitchenTimer> extend(List<KitchenTimer> list, String id, int seconds, long now) {
        List<KitchenTimer> out = new ArrayList<>();
        for (KitchenTimer t : list) {
            KitchenTimer c = t.copy();
            if (c.id.equals(id) && seconds > 0) {
                c.endsAt = (c.rang(now) ? now : c.endsAt) + seconds * 1000L;
                c.total += seconds;
            }
            out.add(c);
        }
        return out;
    }

    /** Stop: off the list, ringing or not. */
    public static List<KitchenTimer> without(List<KitchenTimer> list, String id) {
        List<KitchenTimer> out = new ArrayList<>();
        for (KitchenTimer t : list) if (!t.id.equals(id)) out.add(t.copy());
        return out;
    }

    /** The ids on `before` that `after` no longer has. */
    public static List<String> gone(List<KitchenTimer> before, List<KitchenTimer> after) {
        List<String> out = new ArrayList<>();
        for (KitchenTimer t : before) if (find(after, t.id) == null) out.add(t.id);
        return out;
    }

    /** The timers on `after` that are new, or not as they were on `before`. */
    public static List<KitchenTimer> changed(List<KitchenTimer> before, List<KitchenTimer> after) {
        List<KitchenTimer> out = new ArrayList<>();
        for (KitchenTimer t : after) if (!t.sameAs(find(before, t.id))) out.add(t);
        return out;
    }

    /** "Simmer · Chili", or whichever of the two there is. */
    public String line() {
        if (label.isEmpty()) return recipe;
        if (recipe.isEmpty()) return label;
        return label + " · " + recipe;
    }
}
