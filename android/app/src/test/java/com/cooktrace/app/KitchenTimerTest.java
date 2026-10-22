package com.cooktrace.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * What the phone does with its cook timers when nobody has the app open: a
 * notification's +1 Min and Stop, and which timers a new list from the app
 * actually changes (only those have their alarms and notifications redone,
 * so a ringing timer is not rung again by an unrelated change).
 */
public class KitchenTimerTest {

    private static final long NOW = 1_800_000_000_000L;

    private static List<KitchenTimer> two() {
        return Arrays.asList(
            new KitchenTimer("a", "Simmer", "Chili", NOW + 300_000L, 600),
            new KitchenTimer("b", "Rest", "", NOW - 5_000L, 120));
    }

    @Test
    public void plusOneMinuteOnACountingTimerAddsAMinute() {
        List<KitchenTimer> after = KitchenTimer.extend(two(), "a", 60, NOW);
        assertEquals(NOW + 360_000L, KitchenTimer.find(after, "a").endsAt);
        assertEquals(660, KitchenTimer.find(after, "a").total);
        // The other one is left as it was.
        assertEquals(NOW - 5_000L, KitchenTimer.find(after, "b").endsAt);
    }

    @Test
    public void plusOneMinuteOnOneThatRangCountsAMinuteFromNow() {
        List<KitchenTimer> after = KitchenTimer.extend(two(), "b", 60, NOW);
        KitchenTimer b = KitchenTimer.find(after, "b");
        assertEquals(NOW + 60_000L, b.endsAt);
        assertFalse(b.rang(NOW));
    }

    @Test
    public void stopTakesItOffTheList() {
        List<KitchenTimer> after = KitchenTimer.without(two(), "b");
        assertEquals(1, after.size());
        assertNull(KitchenTimer.find(after, "b"));
        assertEquals(Collections.singletonList("b"), KitchenTimer.gone(two(), after));
    }

    @Test
    public void theListIsNotChangedInPlace() {
        List<KitchenTimer> before = two();
        KitchenTimer.extend(before, "a", 60, NOW);
        assertEquals(NOW + 300_000L, KitchenTimer.find(before, "a").endsAt);
    }

    @Test
    public void onlyWhatChangedIsRedone() {
        List<KitchenTimer> before = two();
        List<KitchenTimer> same = two();
        assertTrue(KitchenTimer.changed(before, same).isEmpty());
        assertTrue(KitchenTimer.gone(before, same).isEmpty());

        List<KitchenTimer> later = KitchenTimer.extend(before, "a", 60, NOW);
        List<KitchenTimer> changed = KitchenTimer.changed(before, later);
        assertEquals(1, changed.size());
        assertEquals("a", changed.get(0).id);

        List<KitchenTimer> added = Arrays.asList(
            before.get(0), before.get(1), new KitchenTimer("c", "Eggs", "", NOW + 240_000L, 240));
        assertEquals("c", KitchenTimer.changed(before, added).get(0).id);
    }

    @Test
    public void whatItSays() {
        assertEquals("Simmer · Chili", two().get(0).line());
        assertEquals("Rest", two().get(1).line());
        assertEquals("Chili", new KitchenTimer("x", "", "Chili", NOW, 1).line());
    }
}
