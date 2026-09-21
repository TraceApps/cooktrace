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
     * Every cook underway, each by the id the SERVER uses, with what has been
     * ticked off it. A list rather than a single cook: a meal is usually two
     * dishes, and two devices sharing one slot would overwrite each other.
     */
    @PluginMethod
    public void cooks(PluginCall call) {
        PutDataMapRequest req = PutDataMapRequest.create(COOK_PATH);
        java.util.ArrayList<com.google.android.gms.wearable.DataMap> out = new java.util.ArrayList<>();
        com.getcapacitor.JSArray list = call.getArray("cooks");
        if (list != null) {
            try {
                for (Object entry : list.toList()) {
                    if (!(entry instanceof org.json.JSONObject)) continue;
                    org.json.JSONObject o = (org.json.JSONObject) entry;
                    long id = o.optLong("serverRecipeId", 0L);
                    if (id <= 0) continue;
                    com.google.android.gms.wearable.DataMap one = new com.google.android.gms.wearable.DataMap();
                    one.putLong("serverRecipeId", id);
                    one.putString("name", o.optString("name", ""));
                    one.putIntegerArrayList("steps", intList(o.optJSONArray("steps")));
                    one.putStringArrayList("ingredients", stringList(o.optJSONArray("ingredients")));
                    out.add(one);
                }
            } catch (Exception e) {
                Log.w(TAG, "could not read the cooks: " + e.getMessage());
            }
        }
        req.getDataMap().putDataMapArrayList("cooks", out);
        req.getDataMap().putLong("at", stampOf(call));
        Log.i(TAG, "sending " + out.size() + " cook(s) to the watch");
        Wearable.getDataClient(getContext()).putDataItem(req.asPutDataRequest().setUrgent())
            .addOnSuccessListener(item -> call.resolve())
            .addOnFailureListener(e -> {
                Log.w(TAG, "the cooks did not reach the watch: " + e.getMessage());
                call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage());
            });
    }

    private java.util.ArrayList<Integer> intList(org.json.JSONArray arr) {
        java.util.ArrayList<Integer> out = new java.util.ArrayList<>();
        for (int i = 0; arr != null && i < arr.length(); i++) out.add(arr.optInt(i));
        return out;
    }

    private java.util.ArrayList<String> stringList(org.json.JSONArray arr) {
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        for (int i = 0; arr != null && i < arr.length(); i++) {
            String s = arr.optString(i, "");
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    /** What the watch says about the cooks, newest record wins. */
    @PluginMethod
    public void readCooks(PluginCall call) {
        Wearable.getDataClient(getContext()).getDataItems()
            .addOnSuccessListener(items -> {
                JSObject ret = new JSObject();
                ret.put("found", false);
                long newest = 0L;
                for (com.google.android.gms.wearable.DataItem item : items) {
                    String path = item.getUri().getPath();
                    if (path == null || !path.startsWith(COOK_PATH)) continue;
                    com.google.android.gms.wearable.DataMap map = DataMapItem.fromDataItem(item).getDataMap();
                    long at = map.getLong("at", 0L);
                    if (at < newest) continue;
                    newest = at;
                    com.getcapacitor.JSArray cooks = new com.getcapacitor.JSArray();
                    java.util.ArrayList<com.google.android.gms.wearable.DataMap> raw =
                        map.getDataMapArrayList("cooks");
                    for (int i = 0; raw != null && i < raw.size(); i++) {
                        com.google.android.gms.wearable.DataMap one = raw.get(i);
                        JSObject cook = new JSObject();
                        cook.put("serverRecipeId", one.getLong("serverRecipeId", 0L));
                        cook.put("name", one.getString("name", ""));
                        cook.put("steps", new com.getcapacitor.JSArray(one.getIntegerArrayList("steps")));
                        cook.put("ingredients", new com.getcapacitor.JSArray(one.getStringArrayList("ingredients")));
                        cooks.put(cook);
                    }
                    ret.put("found", true);
                    ret.put("at", at);
                    ret.put("cooks", cooks);
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
