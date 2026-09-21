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
    private const val KEY_RECIPE = "recipe"
    const val KEY_TIMERS = "timers"
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
            for (item in items) {
                val path = item.uri.path.orEmpty()
                if (path.startsWith(PairingService.COOK_PATH)) {
                    // putCook ignores anything older than what is known, so
                    // the newest wins whatever order these arrive in.
                    putCook(ctx, DataMapItem.fromDataItem(item).dataMap)
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
            .remove(KEY_RECIPE).remove(KEY_TIMERS).remove(KEY_OUTBOX).apply()
    }

    // ── The list the watch last saw ──────────────────────────────────────

    fun list(ctx: Context): String? = prefs(ctx).getString(KEY_LIST, null)

    fun putList(ctx: Context, body: String) {
        prefs(ctx).edit().putString(KEY_LIST, body).putLong(KEY_LIST_AT, System.currentTimeMillis()).apply()
    }

    /** The recipe of the cook in progress, kept so a basement kitchen still has it. */
    fun recipe(ctx: Context): String? = prefs(ctx).getString(KEY_RECIPE, null)

    fun putRecipe(ctx: Context, body: String) {
        prefs(ctx).edit().putString(KEY_RECIPE, body).apply()
    }

    // ── The cook in progress ─────────────────────────────────────────────

    /**
     * The recipe you are cooking and what has been ticked off it. Held by
     * both devices, stamped so the later word wins, since either can tick.
     */
    data class Cook(
        /**
         * The id YOUR SERVER uses. The phone has two for every recipe, its
         * own and the server's, and only this one means anything here: the
         * watch fetches the recipe from the server itself.
         */
        val recipeId: Long,
        val name: String,
        val steps: Set<Int>,
        val ingredients: Set<String>,
        val at: Long,
    )

    fun cook(ctx: Context): Cook? {
        val raw = prefs(ctx).getString(KEY_COOK, null) ?: return null
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val id = o.optLong("recipeId", 0L)
        if (id <= 0) return null
        return Cook(
            recipeId = id,
            name = Kitchen.text(o, "name"),
            steps = o.optJSONArray("steps").toIntSet(),
            ingredients = o.optJSONArray("ingredients").toStringSet(),
            at = o.optLong("at", 0L),
        )
    }

    /** Something the phone (or this watch) said about the cook. */
    fun putCook(ctx: Context, map: DataMap) {
        val at = map.getLong("at", 0L)
        if (at > 0 && at < prefs(ctx).getLong(KEY_COOK_AT, 0L)) return
        if (map.getBoolean("cleared", false) || map.getLong("serverRecipeId", 0L) <= 0) {
            clearCook(ctx, at)
            return
        }
        val o = JSONObject()
            .put("recipeId", map.getLong("serverRecipeId"))
            .put("name", map.getString("name").orEmpty())
            .put("steps", JSONArray((map.getIntegerArrayList("steps") ?: arrayListOf()).toList()))
            .put("ingredients", JSONArray((map.getStringArrayList("ingredients") ?: arrayListOf()).toList()))
            .put("at", at)
        prefs(ctx).edit()
            .putString(KEY_COOK, o.toString())
            .putLong(KEY_COOK_AT, if (at > 0) at else System.currentTimeMillis())
            .apply()
    }

    /**
     * Forget the cook. The stamp only moves when the ending was itself dated:
     * stamping an undated one with the time of day would shut out every
     * record older than this moment, including one about to arrive.
     */
    fun clearCook(ctx: Context, at: Long = 0L) {
        val edit = prefs(ctx).edit().remove(KEY_COOK).remove(KEY_RECIPE)
        if (at > 0) edit.putLong(KEY_COOK_AT, at)
        edit.apply()
    }

    /** The wearer ticked something. Written down here and told to the phone. */
    fun publishCook(ctx: Context, cook: Cook?) {
        val at = System.currentTimeMillis()
        val request = PutDataMapRequest.create(PairingService.COOK_PATH)
        request.dataMap.apply {
            if (cook == null) {
                putBoolean("cleared", true)
            } else {
                putBoolean("cleared", false)
                putLong("serverRecipeId", cook.recipeId)
                putString("name", cook.name)
                putIntegerArrayList("steps", ArrayList(cook.steps.sorted()))
                putStringArrayList("ingredients", ArrayList(cook.ingredients.sorted()))
            }
            putLong("at", at)
        }
        putCook(ctx, request.dataMap)
        runCatching {
            Wearable.getDataClient(ctx).putDataItem(request.asPutDataRequest().setUrgent())
        }.onFailure { Log.w(TAG, "couldn't tell the phone about the cook: " + it.message) }
    }

    // ── Timers, several at once ──────────────────────────────────────────

    /**
     * A pan and an oven at the same time, which is the whole reason a kitchen
     * timer is not a rest timer. Each carries a deadline rather than a count,
     * so a watch that slept still knows where it is.
     */
    data class Timer(val id: Int, val label: String, val total: Int, val endsAt: Long) {
        fun secondsLeft(now: Long): Int = maxOf(0, ((endsAt - now + 999) / 1000).toInt())
        fun done(now: Long): Boolean = endsAt <= now
    }

    fun timers(ctx: Context): List<Timer> {
        val raw = prefs(ctx).getString(KEY_TIMERS, null) ?: return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Timer(o.optInt("id"), Kitchen.text(o, "label"), o.optInt("total"), o.optLong("endsAt"))
        }
    }

    fun putTimers(ctx: Context, timers: List<Timer>) {
        val arr = JSONArray()
        timers.forEach {
            arr.put(
                JSONObject().put("id", it.id).put("label", it.label)
                    .put("total", it.total).put("endsAt", it.endsAt)
            )
        }
        prefs(ctx).edit().putString(KEY_TIMERS, arr.toString()).apply()
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
