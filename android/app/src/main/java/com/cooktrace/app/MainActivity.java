package com.cooktrace.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Custom plugins must be registered BEFORE super.onCreate so the
        // bridge picks them up when it builds its plugin handle map.
        registerPlugin(WearPairingPlugin.class);
        registerPlugin(FoldPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Capacitor's BridgeActivity does all the WebView setup. CookTrace
    // doesn't yet ship native background workers — when notification
    // features land (cook reminders, thaw alerts, etc.), enqueue the
    // schedulers from onCreate here.
}
