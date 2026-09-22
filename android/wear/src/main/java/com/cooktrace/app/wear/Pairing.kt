package com.cooktrace.app.wear

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the watch needs to reach the server, the list it last saw, the cook it
 * is in, and anything ticked while it could not reach anything.
 *
 * The phone sends the address and a token once over the Wearable Data Layer
 * (PairingService picks them up). Nothing is asked of the wearer: there is no
 * keyboard on a watch worth typing a server address into.
 *
 * The cook travels the same way. Pressing Cook on the phone publishes the
 * recipe and what has been ticked off it, and the watch publishes back when
 * you tick something on your wrist, so the two agree while your hands are
 * covered in flour. Each write is stamped and the later one wins.
 */
object Pairing {

    data class Config(val serverUrl: String, val token: String)

    private const val TAG = "CookTraceWear"
    private const val PREFS = "cooktrace.wear"
    const val KEY_URL = "server_url"
    const val KEY_TOKEN = "token"
    private const val KEY_REFUSED = "refused_token"
    private const val KEY_LIST = "list"
    private const val KEY_LIST_AT = "list_at"
    const val KEY_COOK = "cook"
    private const val KEY_COOK_AT = "cook_at"
    private const val KEY_RECIPE = "recipe_"
    const val KEY_TIMERS = "timers"
    private const val KEY_TIMERS_AT = "timers_at"
    private const val KEY_OUTBOX = "outbox"
    private const val KEY_SEQ = "outbox_seq"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Tell me when any of this changes. The phone's half arrives on a
     * background service, so without this the app would sit there showing
     * what it read when it opened.
     */
    fun watch(ctx: Context, onChange: (String) -> Unit): SharedPreferences.OnSharedPreferenceChangeListener {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key != null) onChange(key)
        }
        prefs(ctx).registerOnSharedPreferenceChangeListener(listener)
        return listener
    }

    // ── Reaching the server ──────────────────────────────────────────────

    fun config(ctx: Context): Config? {
        val p = prefs(ctx)
        val url = p.getString(KEY_URL, null)?.takeIf { it.isNotBlank() }
        val token = p.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
        return if (url != null && token != null) Config(url, token) else null
    }

    /**
     * Read whatever the phone has already published, rather than only waiting
     * for onDataChanged. A listener only fires on a change, so an app opened
     * after the phone published would sit there saying "pair from your phone"
     * with the pairing sitting right there unread.
     */
    suspend fun pullFromPhone(ctx: Context): Config? {
        val existing = config(ctx)
        return try {
            val items = Wearable.getDataClient(ctx).getDataItems().await()
            var found: Config? = null
            val timerItems = ArrayList<DataMap>()
            for (item in items) {
                val path = item.uri.path.orEmpty()
                if (path.startsWith(PairingService.COOK_PATH)) {
                    // putCooks ignores anything older than what is known, so
                    // the newest wins whatever order these arrive in.
                    putCooks(ctx, DataMapItem.fromDataItem(item).dataMap)
                    continue
                }
                if (path.startsWith(PairingService.TIMER_PATH)) {
                    // After the cooks, on purpose: whether timers are shared
                    // at all depends on there being a cook, and both are being
                    // read here in whatever order they arrive.
                    timerItems.add(DataMapItem.fromDataItem(item).dataMap)
                    continue
                }
                if (!path.startsWith(PairingService.PATH)) continue
                val map = DataMapItem.fromDataItem(item).dataMap
                val url = map.getString("serverUrl").orEmpty()
                val token = map.getString("token").orEmpty()
                if (url.isBlank() || token.isBlank()) continue
                if (token == prefs(ctx).getString(KEY_REFUSED, null)) continue
                save(ctx, url, token)
                found = Config(url.trimEnd('/'), token)
            }
            items.release()
            timerItems.forEach { adoptTimers(ctx, it) }
            found ?: existing
        } catch (e: Exception) {
            Log.w(TAG, "couldn't read the pairing: " + e.message)
            existing
        }
    }

    fun save(ctx: Context, serverUrl: String, token: String) {
        prefs(ctx).edit()
            .putString(KEY_URL, serverUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN, token.trim())
            // A fresh token: whatever was refused before is history.
            .remove(KEY_REFUSED)
            .apply()
    }

    /**
     * The token stopped working. The address, the saved list and anything
     * waiting are kept: the wearer hasn't signed out, and the phone hands
     * over a fresh token the next time it is opened.
     */
    fun forget(ctx: Context) {
        val refused = prefs(ctx).getString(KEY_TOKEN, null).orEmpty()
        prefs(ctx).edit().remove(KEY_TOKEN).putString(KEY_REFUSED, refused).apply()
    }

    /** The phone says the account signed out, or the watch was unpaired. */
    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY_URL).remove(KEY_TOKEN).remove(KEY_REFUSED)
            .remove(KEY_LIST).remove(KEY_LIST_AT).remove(KEY_COOK).remove(KEY_COOK_AT)
            .remove(KEY_TIMERS).remove(KEY_TIMERS_AT).remove(KEY_OUTBOX).apply()
        forgetRecipesExcept(ctx, emptySet())
    }

    // ── The list the watch last saw ──────────────────────────────────────

    fun list(ctx: Context): String? = prefs(ctx).getString(KEY_LIST, null)

    fun putList(ctx: Context, body: String) {
        prefs(ctx).edit().putString(KEY_LIST, body).putLong(KEY_LIST_AT, System.currentTimeMillis()).apply()
    }

    // ── The cook in progress ─────────────────────────────────────────────

    /**
     * A recipe being cooked and what has been ticked off it. Several can be
     * underway at once, which is what a meal usually is, so what travels
     * between the devices is the whole list: two of them editing one slot
     * would spend their time undoing each other.
     */
    data class Cook(
        /**
         * The id YOUR SERVER uses. The phone has two for every recipe, its
         * own and the server's, and only this one means anything here: the
         * watch fetches the recipe from the server itself.
         */
        val serverRecipeId: Long,
        val name: String,
        val steps: Set<Int>,
        val ingredients: Set<String>,
    )

    fun cooks(ctx: Context): List<Cook> {
        val raw = prefs(ctx).getString(KEY_COOK, null) ?: return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optLong("serverRecipeId", 0L)
            if (id <= 0) return@mapNotNull null
            Cook(
                serverRecipeId = id,
                name = Kitchen.text(o, "name"),
                steps = o.optJSONArray("steps").toIntSet(),
                ingredients = o.optJSONArray("ingredients").toStringSet(),
            )
        }
    }

    /** Something the phone (or this watch) said about the cooks. */
    fun putCooks(ctx: Context, map: DataMap) {
        val at = map.getLong("at", 0L)
        if (at > 0 && at < prefs(ctx).getLong(KEY_COOK_AT, 0L)) return
        val arr = JSONArray()
        for (one in map.getDataMapArrayList("cooks").orEmpty()) {
            val id = one.getLong("serverRecipeId", 0L)
            if (id <= 0) continue
            arr.put(
                JSONObject()
                    .put("serverRecipeId", id)
                    .put("name", one.getString("name").orEmpty())
                    .put("steps", JSONArray((one.getIntegerArrayList("steps") ?: arrayListOf()).toList()))
                    .put("ingredients", JSONArray((one.getStringArrayList("ingredients") ?: arrayListOf()).toList()))
            )
        }
        prefs(ctx).edit()
            .putString(KEY_COOK, arr.toString())
            .putLong(KEY_COOK_AT, if (at > 0) at else System.currentTimeMillis())
            .apply()
    }

    /** The wearer ticked something. Written down here and told to the phone. */
    fun publishCooks(ctx: Context, cooks: List<Cook>) {
        val at = System.currentTimeMillis()
        val request = PutDataMapRequest.create(PairingService.COOK_PATH)
        val out = ArrayList<DataMap>()
        for (cook in cooks) {
            out.add(
                DataMap().apply {
                    putLong("serverRecipeId", cook.serverRecipeId)
                    putString("name", cook.name)
                    putIntegerArrayList("steps", ArrayList(cook.steps.sorted()))
                    putStringArrayList("ingredients", ArrayList(cook.ingredients.sorted()))
                }
            )
        }
        request.dataMap.putDataMapArrayList("cooks", out)
        request.dataMap.putLong("at", at)
        putCooks(ctx, request.dataMap)
        runCatching {
            Wearable.getDataClient(ctx).putDataItem(request.asPutDataRequest().setUrgent())
        }.onFailure { Log.w(TAG, "couldn't tell the phone about the cooks: " + it.message) }
    }

    /** The recipe behind a cook, kept so a basement kitchen still has it. */
    fun recipe(ctx: Context, serverRecipeId: Long): String? =
        prefs(ctx).getString(KEY_RECIPE + serverRecipeId, null)

    fun putRecipe(ctx: Context, serverRecipeId: Long, body: String) {
        prefs(ctx).edit().putString(KEY_RECIPE + serverRecipeId, body).apply()
    }

    /** Recipes for cooks that are over are not worth keeping. */
    fun forgetRecipesExcept(ctx: Context, keep: Set<Long>) {
        val edit = prefs(ctx).edit()
        for (key in prefs(ctx).all.keys) {
            if (!key.startsWith(KEY_RECIPE)) continue
            val id = key.removePrefix(KEY_RECIPE).toLongOrNull() ?: continue
            if (id !in keep) edit.remove(key)
        }
        edit.apply()
    }

    // ── Timers, several at once ──────────────────────────────────────────

    /**
     * A pan and an oven at the same time, which is the whole reason a kitchen
     * timer is not a rest timer. Each carries a deadline rather than a count,
     * so a watch that slept still knows where it is.
     */
    data class Timer(
        val id: Int,
        val label: String,
        val total: Int,
        val endsAt: Long,
        /**
         * The same timer on both devices. The id is this watch's own, because
         * an alarm is cancelled by request code and those have to be small;
         * the key is what the phone knows it by, and it is what the two
         * devices match on.
         */
        val key: String = "",
    ) {
        fun secondsLeft(now: Long): Int = maxOf(0, ((endsAt - now + 999) / 1000).toInt())
        fun done(now: Long): Boolean = endsAt <= now
        /** Something to match on for a timer that started before keys did. */
        val matchKey: String get() = if (key.isNotBlank()) key else "w$id-$endsAt"
    }

    fun timers(ctx: Context): List<Timer> {
        val raw = prefs(ctx).getString(KEY_TIMERS, null) ?: return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Timer(
                o.optInt("id"), Kitchen.text(o, "label"), o.optInt("total"),
                o.optLong("endsAt"), Kitchen.text(o, "key"),
            )
        }
    }

    fun putTimers(ctx: Context, timers: List<Timer>) {
        val arr = JSONArray()
        timers.forEach {
            arr.put(
                JSONObject().put("id", it.id).put("label", it.label)
                    .put("total", it.total).put("endsAt", it.endsAt)
                    .put("key", it.matchKey)
            )
        }
        prefs(ctx).edit().putString(KEY_TIMERS, arr.toString()).apply()
    }

    /**
     * Timers cross between the phone and the watch only while a cook has been
     * handed over. Off a cook, a timer set on the phone has no business
     * scheduling an alarm on a watch in a drawer, and the watch has no
     * business being woken to hear about one.
     */
    fun sharingTimers(ctx: Context): Boolean = cooks(ctx).isNotEmpty()

    /** The wearer started, extended or stopped one. Tell the phone. */
    fun publishTimers(ctx: Context, timers: List<Timer>) {
        if (!sharingTimers(ctx)) return
        val at = System.currentTimeMillis()
        prefs(ctx).edit().putLong(KEY_TIMERS_AT, at).apply()
        val request = PutDataMapRequest.create(PairingService.TIMER_PATH)
        val out = ArrayList<DataMap>()
        for (timer in timers) {
            out.add(
                DataMap().apply {
                    putString("key", timer.matchKey)
                    putString("label", timer.label)
                    putInt("total", timer.total)
                    putLong("endsAt", timer.endsAt)
                }
            )
        }
        request.dataMap.putDataMapArrayList("timers", out)
        request.dataMap.putLong("at", at)
        runCatching {
            Wearable.getDataClient(ctx).putDataItem(request.asPutDataRequest().setUrgent())
        }.onFailure { Log.w(TAG, "couldn't tell the phone about the timers: " + it.message) }
    }

    /**
     * What the phone says is counting. The later word wins, as everywhere
     * else, and the alarms are made to match: one is scheduled for a timer
     * that is new here and cancelled for one that has gone.
     */
    fun adoptTimers(ctx: Context, map: DataMap) {
        if (!sharingTimers(ctx)) return
        val at = map.getLong("at", 0L)
        if (at > 0 && at < prefs(ctx).getLong(KEY_TIMERS_AT, 0L)) return
        val now = System.currentTimeMillis()
        val mine = timers(ctx)
        val taken = HashSet(mine.map { it.id })
        val kept = ArrayList<Timer>()
        for (one in map.getDataMapArrayList("timers").orEmpty()) {
            val endsAt = one.getLong("endsAt", 0L)
            if (endsAt <= now) continue
            val key = one.getString("key").orEmpty()
            if (key.isBlank()) continue
            val was = mine.firstOrNull { it.matchKey == key }
            // Its own id here, so the alarm it already has is the alarm it
            // keeps; a new one takes the lowest free number.
            val id = was?.id ?: (1..8).firstOrNull { it !in taken } ?: continue
            taken.add(id)
            val timer = Timer(id, one.getString("label").orEmpty(), one.getInt("total", 0), endsAt, key)
            kept.add(timer)
            if (was == null || was.endsAt != endsAt) KitchenAlarm.schedule(ctx, id, endsAt)
        }
        // Whatever the phone no longer has is over, and its alarm with it.
        val living = kept.map { it.id }.toSet()
        mine.filterNot { it.id in living }.forEach { KitchenAlarm.cancel(ctx, it.id) }
        putTimers(ctx, kept)
        prefs(ctx).edit().putLong(KEY_TIMERS_AT, if (at > 0) at else now).apply()
    }

    // ── Ticked with no connection ────────────────────────────────────────

    /**
     * One thing the watch did, waiting to be sent: an item ticked off the
     * list, or a recipe logged as cooked.
     */
    data class Op(
        val kind: String,
        val itemId: Long = 0,
        val checked: Boolean = false,
        val recipeId: Long = 0,
        val date: String = "",
        val seq: Long = 0,
    ) {
        /** One entry per thing, so ticking twice is a correction, not two. */
        val key: String get() = if (kind == COOKED) "$COOKED:$recipeId:$date" else "$CHECK:$itemId"

        fun toJson(): JSONObject = JSONObject()
            .put("kind", kind).put("itemId", itemId).put("checked", checked)
            .put("recipeId", recipeId).put("date", date).put("seq", seq)

        companion object {
            const val CHECK = "check"
            const val COOKED = "cooked"

            fun from(o: JSONObject) = Op(
                kind = Kitchen.text(o, "kind").ifBlank { CHECK },
                itemId = o.optLong("itemId"),
                checked = o.optBoolean("checked", false),
                recipeId = o.optLong("recipeId"),
                date = Kitchen.text(o, "date"),
                seq = o.optLong("seq", 0L),
            )
        }
    }

    fun outbox(ctx: Context): List<Op> {
        val raw = prefs(ctx).getString(KEY_OUTBOX, null) ?: return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { runCatching { Op.from(arr.getJSONObject(it)) }.getOrNull() }
    }

    fun queue(ctx: Context, op: Op) {
        val next = prefs(ctx).getLong(KEY_SEQ, 0L) + 1
        prefs(ctx).edit().putLong(KEY_SEQ, next).apply()
        val kept = outbox(ctx).filterNot { it.key == op.key }
        writeOutbox(ctx, kept + op.copy(seq = next))
    }

    fun writeOutbox(ctx: Context, ops: List<Op>) {
        val arr = JSONArray()
        ops.forEach { arr.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY_OUTBOX, arr.toString()).apply()
    }

    private fun JSONArray?.toIntSet(): Set<Int> =
        (0 until (this?.length() ?: 0)).map { this!!.optInt(it) }.toSet()

    private fun JSONArray?.toStringSet(): Set<String> =
        (0 until (this?.length() ?: 0)).mapNotNull { this!!.optString(it).takeIf { s -> s.isNotBlank() } }.toSet()
}
