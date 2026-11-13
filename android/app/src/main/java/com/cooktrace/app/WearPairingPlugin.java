package com.cooktrace.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Log;

import android.os.Handler;
import android.os.Looper;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.TaskCompletionSource;
import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.wearable.DataClient;
import com.google.android.gms.wearable.DataMapItem;
import com.google.android.gms.wearable.MessageClient;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.PutDataRequest;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

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
    /** What is counting down, shared only while a cook is handed over. */
    private static final String TIMER_PATH = "/cooktrace/timers";
    private static final String TAG = "WearPairing";
    /**
     * Local mode: the watch asks this phone what it would ask a server, and
     * the app's own local handlers answer (watch-relay.js). Registered only
     * while the app runs, so with the app closed the watch keeps what it
     * ticked and says to open CookTrace on the phone.
     */
    private static final String API_PATH = "/cooktrace/api";
    private static final long ANSWER_WITHIN_MS = 20000L;
    private final Map<String, TaskCompletionSource<byte[]>> waiting = new ConcurrentHashMap<>();
    private final Handler timeouts = new Handler(Looper.getMainLooper());

    private static byte[] reply(int status, String body) {
        try {
            return new JSONObject().put("status", status).put("body", body == null ? "" : body)
                .toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return ("{\"status\":" + status + "}").getBytes(StandardCharsets.UTF_8);
        }
    }

    private final MessageClient.RpcService apiService = (nodeId, path, data) -> {
        // The watch is in use: the app stays awake for it when it leaves the screen.
        WatchAwakeService.lastWatchRequestAt = System.currentTimeMillis();
        if (!hasListeners("watchRequest")) {
            return Tasks.forResult(reply(503, "{\"error\":\"CookTrace isn't ready on the phone\"}"));
        }
        JSObject req = new JSObject();
        try {
            JSONObject in = new JSONObject(new String(data == null ? new byte[0] : data, StandardCharsets.UTF_8));
            req.put("method", in.optString("method", "GET"));
            req.put("path", in.optString("path", ""));
            req.put("body", in.isNull("body") ? null : in.optString("body", null));
        } catch (Exception e) {
            return Tasks.forResult(reply(400, "{\"error\":\"Bad request\"}"));
        }
        String id = UUID.randomUUID().toString();
        req.put("id", id);
        TaskCompletionSource<byte[]> answer = new TaskCompletionSource<>();
        waiting.put(id, answer);
        // An app that never answers (busy, or going away) still lets the watch
        // move on: it keeps what it ticked and tries again.
        timeouts.postDelayed(() -> {
            TaskCompletionSource<byte[]> late = waiting.remove(id);
            if (late != null) late.trySetResult(reply(504, "{\"error\":\"The phone took too long\"}"));
        }, ANSWER_WITHIN_MS);
        notifyListeners("watchRequest", req);
        return answer.getTask();
    };

    /** The running plugin, for the debug build's stand-in watch (src/debug WatchRequestProbe). */
    static volatile WearPairingPlugin current;

    /** Ask the way the watch does; only the debug build calls this. */
    Task<byte[]> askLikeTheWatch(byte[] data) {
        return apiService.onRequest("debug", API_PATH, data);
    }

    @Override
    public void load() {
        try {
            Wearable.getMessageClient(getContext()).addRpcService(apiService, API_PATH);
            current = this;
        } catch (Exception e) {
            Log.w(TAG, "no watch messages here: " + e.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            Wearable.getMessageClient(getContext()).removeRpcService(apiService);
            if (current == this) current = null;
        } catch (Exception e) {
            Log.w(TAG, "couldn't stop listening: " + e.getMessage());
        }
    }

    /**
     * Keep the app awake for the watch while it's off screen (on), or not
     * (off). On only takes effect with a watch connected or used in the last
     * 30 minutes, so a phone with no watch around shows nothing.
     */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        if (!Boolean.TRUE.equals(call.getBoolean("on", false))) {
            WatchAwakeService.stop(getContext());
            call.resolve();
            return;
        }
        String title = call.getString("title", "CookTrace");
        String text = call.getString("text", "");
        // Used lately, or connected now: you may start on the watch after
        // putting the phone away, and by then a frozen app couldn't answer.
        if (WatchAwakeService.watchInUse()) {
            WatchAwakeService.start(getContext(), title, text);
            call.resolve();
            return;
        }
        Wearable.getNodeClient(getContext()).getConnectedNodes()
            .addOnSuccessListener(nodes -> {
                if (nodes != null && !nodes.isEmpty()) WatchAwakeService.start(getContext(), title, text);
                call.resolve();
            })
            .addOnFailureListener(e -> call.resolve());
    }

    /** The app's answer to one of the watch's requests. */
    @PluginMethod
    public void answer(PluginCall call) {
        TaskCompletionSource<byte[]> answer = waiting.remove(call.getString("id", ""));
        if (answer != null) {
            Integer status = call.getInt("status", 500);
            answer.trySetResult(reply(status == null ? 500 : status, call.getString("body", "")));
        }
        call.resolve();
    }

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
        // The server again when the app confirmed plain HTTP to it (a server on
        // your own network, TraceApps/nutritrace#194), otherwise empty: the
        // watch sends over plain HTTP only when they match.
        req.getDataMap().putString("httpOk", call.getString("httpOk", ""));
        req.getDataMap().putString("token", token);
        // The release this phone runs: a watch on an older one updates itself
        // to it (installed from GitHub; the Play Store keeps its own current).
        req.getDataMap().putString("appVersion", call.getString("appVersion", ""));
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
        // Read as any number: Capacitor's getDouble answers with the default
        // for a Long, and a time in milliseconds always arrives as one, so
        // every stamp read as "now" and a stale republish beat a newer word.
        Object at = call.getData().opt("at");
        long stamp = at instanceof Number ? ((Number) at).longValue() : 0L;
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
        // Whose ids these are: this phone's own (Local mode) or the server's.
        req.getDataMap().putBoolean("local", Boolean.TRUE.equals(call.getBoolean("local", false)));
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

    /**
     * What is counting down in the kitchen, so the phone and the wrist agree
     * about the clock. Each timer carries a key both devices know it by and
     * an absolute deadline, never a remaining count: a few seconds in the
     * post then delays when it appears rather than making it wrong.
     */
    @PluginMethod
    public void timers(PluginCall call) {
        PutDataMapRequest req = PutDataMapRequest.create(TIMER_PATH);
        java.util.ArrayList<com.google.android.gms.wearable.DataMap> out = new java.util.ArrayList<>();
        com.getcapacitor.JSArray list = call.getArray("timers");
        if (list != null) {
            try {
                for (Object entry : list.toList()) {
                    if (!(entry instanceof org.json.JSONObject)) continue;
                    org.json.JSONObject o = (org.json.JSONObject) entry;
                    String key = o.optString("key", "");
                    long endsAt = o.optLong("endsAt", 0L);
                    if (key.isEmpty() || endsAt <= 0) continue;
                    com.google.android.gms.wearable.DataMap one = new com.google.android.gms.wearable.DataMap();
                    one.putString("key", key);
                    one.putString("label", o.optString("label", ""));
                    one.putInt("total", o.optInt("total", 0));
                    one.putLong("endsAt", endsAt);
                    out.add(one);
                }
            } catch (Exception e) {
                Log.w(TAG, "could not read the timers: " + e.getMessage());
            }
        }
        req.getDataMap().putDataMapArrayList("timers", out);
        req.getDataMap().putLong("at", stampOf(call));
        Log.i(TAG, "sending " + out.size() + " timer(s) to the watch");
        Wearable.getDataClient(getContext()).putDataItem(req.asPutDataRequest().setUrgent())
            .addOnSuccessListener(item -> call.resolve())
            .addOnFailureListener(e -> {
                Log.w(TAG, "the timers did not reach the watch: " + e.getMessage());
                call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage());
            });
    }

    /** What the watch says is counting, newest record wins. */
    @PluginMethod
    public void readTimers(PluginCall call) {
        Wearable.getDataClient(getContext()).getDataItems()
            .addOnSuccessListener(items -> {
                JSObject ret = new JSObject();
                ret.put("found", false);
                long newest = 0L;
                for (com.google.android.gms.wearable.DataItem item : items) {
                    String path = item.getUri().getPath();
                    if (path == null || !path.startsWith(TIMER_PATH)) continue;
                    com.google.android.gms.wearable.DataMap map = DataMapItem.fromDataItem(item).getDataMap();
                    long at = map.getLong("at", 0L);
                    // One record per device on the same path: take the one
                    // with the later stamp, not whichever comes back first.
                    if (at < newest) continue;
                    newest = at;
                    com.getcapacitor.JSArray timers = new com.getcapacitor.JSArray();
                    java.util.ArrayList<com.google.android.gms.wearable.DataMap> raw =
                        map.getDataMapArrayList("timers");
                    for (int i = 0; raw != null && i < raw.size(); i++) {
                        com.google.android.gms.wearable.DataMap one = raw.get(i);
                        JSObject timer = new JSObject();
                        timer.put("key", one.getString("key", ""));
                        timer.put("label", one.getString("label", ""));
                        timer.put("total", one.getInt("total", 0));
                        timer.put("endsAt", one.getLong("endsAt", 0L));
                        timers.put(timer);
                    }
                    ret.put("found", true);
                    ret.put("at", at);
                    ret.put("timers", timers);
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
                    ret.put("local", map.getBoolean("local", false));
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
