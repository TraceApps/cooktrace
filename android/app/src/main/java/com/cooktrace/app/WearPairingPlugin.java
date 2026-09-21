package com.cooktrace.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Log;

import com.google.android.gms.wearable.DataClient;
import com.google.android.gms.wearable.DataMapItem;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.PutDataRequest;
import com.google.android.gms.wearable.Wearable;

/**
 * Hands the watch what it needs to reach the server: the address and the
 * signed-in account's token, written once into the Wearable Data Layer. The
 * watch app (android/wear) picks it up and talks to the server itself, so it
 * ticks a shopping list off in an aisle with no phone signal.
 *
 * It also carries the cook: pressing Cook on the phone hands the recipe and
 * what has been ticked off it to the wrist, and the watch hands back what you
 * tick there.
 *
 * Nothing is typed on the watch, and signing out on the phone takes the
 * credentials away again.
 */
@CapacitorPlugin(name = "WearPairing")
public class WearPairingPlugin extends Plugin {

    private static final String PATH = "/cooktrace/pairing";
    private static final String COOK_PATH = "/cooktrace/cook";
    private static final String TAG = "WearPairing";

    /** True when a watch is paired with this phone, so the UI can say so. */
    @PluginMethod
    public void hasWatch(PluginCall call) {
        Wearable.getNodeClient(getContext()).getConnectedNodes()
            .addOnSuccessListener(nodes -> {
                Log.i(TAG, "connected nodes: " + (nodes == null ? 0 : nodes.size()));
                JSObject ret = new JSObject();
                ret.put("paired", nodes != null && !nodes.isEmpty());
                ret.put("count", nodes == null ? 0 : nodes.size());
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                Log.w(TAG, "couldn't list nodes: " + e.getMessage());
                JSObject ret = new JSObject();
                ret.put("paired", false);
                ret.put("count", 0);
                call.resolve(ret);
            });
    }

    /** Send the server address and token to the watch. */
    @PluginMethod
    public void pair(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "");
        String token = call.getString("token", "");
        if (serverUrl == null || serverUrl.isEmpty() || token == null || token.isEmpty()) {
            call.reject("serverUrl and token are required");
            return;
        }
        PutDataMapRequest req = PutDataMapRequest.create(PATH);
        req.getDataMap().putString("serverUrl", serverUrl);
        req.getDataMap().putString("token", token);
        // The timestamp makes every write distinct, so re-pairing after a token
        // refresh still reaches the watch instead of being seen as unchanged.
        req.getDataMap().putLong("at", System.currentTimeMillis());
        PutDataRequest put = req.asPutDataRequest().setUrgent();

        DataClient client = Wearable.getDataClient(getContext());
        client.putDataItem(put)
            .addOnSuccessListener(item -> {
                Log.i(TAG, "sent the link to the watch");
                JSObject ret = new JSObject();
                ret.put("sent", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }

    /**
     * The stamp comes from whoever made the change, so both devices judge by
     * the same clock reading rather than by when a write happened.
     */
    private long stampOf(PluginCall call) {
        Double at = call.getDouble("at", 0d);
        long stamp = at == null ? 0L : at.longValue();
        return stamp > 0 ? stamp : System.currentTimeMillis();
    }

    /**
     * The cook you are in: which recipe, and what has been ticked off it.
     * Sent whenever either side ticks something, stamped so the later word
     * wins, since the watch can tick too.
     */
    @PluginMethod
    public void cook(PluginCall call) {
        PutDataMapRequest req = PutDataMapRequest.create(COOK_PATH);
        req.getDataMap().putBoolean("cleared", false);
        req.getDataMap().putLong("recipeId", call.getDouble("recipeId", 0d).longValue());
        req.getDataMap().putString("name", call.getString("name", ""));
        req.getDataMap().putIntegerArrayList("steps", intList(call.getArray("steps")));
        req.getDataMap().putStringArrayList("ingredients", stringList(call.getArray("ingredients")));
        req.getDataMap().putLong("at", stampOf(call));
        long recipeId = req.getDataMap().getLong("recipeId", 0L);
        Log.i(TAG, "sending the cook to the watch: recipe " + recipeId
            + ", " + req.getDataMap().getIntegerArrayList("steps").size() + " steps ticked");
        Wearable.getDataClient(getContext()).putDataItem(req.asPutDataRequest().setUrgent())
            .addOnSuccessListener(item -> call.resolve())
            .addOnFailureListener(e -> {
                Log.w(TAG, "the cook did not reach the watch: " + e.getMessage());
                call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage());
            });
    }

    private java.util.ArrayList<Integer> intList(com.getcapacitor.JSArray arr) {
        java.util.ArrayList<Integer> out = new java.util.ArrayList<>();
        if (arr == null) return out;
        try {
            for (Object o : arr.toList()) {
                if (o instanceof Number) out.add(((Number) o).intValue());
            }
        } catch (Exception ignored) { }
        return out;
    }

    private java.util.ArrayList<String> stringList(com.getcapacitor.JSArray arr) {
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        if (arr == null) return out;
        try {
            for (Object o : arr.toList()) {
                if (o != null) out.add(String.valueOf(o));
            }
        } catch (Exception ignored) { }
        return out;
    }

    /**
     * What the watch says about the cook. The phone reads this when it comes
     * back to the front and takes it if it is the later word, so a step
     * ticked on the wrist shows on the page.
     */
    @PluginMethod
    public void readCook(PluginCall call) {
        Wearable.getDataClient(getContext()).getDataItems()
            .addOnSuccessListener(items -> {
                JSObject ret = new JSObject();
                ret.put("found", false);
                // Each device keeps its own record at this path, so this has
                // to be the NEWEST of them rather than whichever the loop
                // happens to reach last.
                long newest = 0L;
                for (com.google.android.gms.wearable.DataItem item : items) {
                    String path = item.getUri().getPath();
                    if (path == null || !path.startsWith(COOK_PATH)) continue;
                    com.google.android.gms.wearable.DataMap map =
                        DataMapItem.fromDataItem(item).getDataMap();
                    long at = map.getLong("at", 0L);
                    if (at < newest) continue;
                    newest = at;
                    ret.put("found", true);
                    ret.put("recipeId", map.getLong("recipeId", 0L));
                    ret.put("name", map.getString("name", ""));
                    ret.put("steps", new com.getcapacitor.JSArray(map.getIntegerArrayList("steps")));
                    ret.put("ingredients", new com.getcapacitor.JSArray(map.getStringArrayList("ingredients")));
                    ret.put("at", at);
                    ret.put("cleared", map.getBoolean("cleared", false));
                }
                items.release();
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                JSObject ret = new JSObject();
                ret.put("found", false);
                call.resolve(ret);
            });
    }

    /**
     * The cook ended. Published as a finished marker rather than deleted, so
     * both sides can tell "ended a moment ago" from "nothing has been said
     * yet" and the later word still wins.
     */
    @PluginMethod
    public void clearCook(PluginCall call) {
        PutDataMapRequest req = PutDataMapRequest.create(COOK_PATH);
        req.getDataMap().putBoolean("cleared", true);
        req.getDataMap().putLong("at", stampOf(call));
        Wearable.getDataClient(getContext()).putDataItem(req.asPutDataRequest().setUrgent())
            .addOnSuccessListener(item -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }

    /** Signed out on the phone: take the credentials off the watch. */
    @PluginMethod
    public void unpair(PluginCall call) {
        Wearable.getDataClient(getContext())
            .deleteDataItems(new android.net.Uri.Builder().scheme("wear").path(PATH).build())
            .addOnSuccessListener(count -> {
                JSObject ret = new JSObject();
                ret.put("cleared", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }
}
