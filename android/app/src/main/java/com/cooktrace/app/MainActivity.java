package com.cooktrace.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** The app's own links: cooktrace://new/<kind> from the app icon's shortcuts. */
    static final String LINK_SCHEME = "cooktrace";

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Reopened from Recents, a shortcut's link that started the app is not
        // a new tap: drop it before the bridge reads the launch URL.
        AppShortcutActivity.dropReplayedLink(this, savedInstanceState);
        // Custom plugins must be registered BEFORE super.onCreate so the
        // bridge picks them up when it builds its plugin handle map.
        registerPlugin(WearPairingPlugin.class);
        registerPlugin(FoldPlugin.class);
        registerPlugin(InstallMarkerPlugin.class);
        registerPlugin(KitchenTimersPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Capacitor's BridgeActivity does all the WebView setup. CookTrace
    // doesn't yet ship native background workers — when notification
    // features land (cook reminders, thaw alerts, etc.), enqueue the
    // schedulers from onCreate here.
}
