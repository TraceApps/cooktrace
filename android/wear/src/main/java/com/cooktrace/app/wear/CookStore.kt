package com.cooktrace.app.wear

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.LocalDate

/**
 * What the watch shows, and how it gets there.
 *
 * Every screen reads this one state. Opening draws the list it last saw, so
 * the watch is useful the instant it wakes, then replaces it with the
 * server's answer. Something ticked here shows at once and goes up straight
 * away, or waits until there is a connection: a supermarket aisle and a
 * basement kitchen are both places there isn't one.
 */
class CookStore(private val ctx: Context) {

    data class State(
        val paired: Boolean = false,
        val loading: Boolean = false,
        val offline: Boolean = false,
        val error: String? = null,
        val pending: Int = 0,
        /** A word about what just happened, shown for a moment. */
        val flash: String? = null,
        val items: List<Kitchen.Item> = emptyList(),
        /** The cooks the phone put you in. A meal is often two dishes. */
        val cooks: List<Pairing.Cook> = emptyList(),
        /** The recipe behind each of them, by the id the server uses. */
        val recipes: Map<Long, Kitchen.Recipe> = emptyMap(),
        val timers: List<Pairing.Timer> = emptyList(),
    ) {
        val toBuy: Int get() = items.count { !it.checked }
    }

    private val _state = MutableStateFlow(State(paired = Pairing.config(ctx) != null))
    val state: StateFlow<State> = _state

    /**
     * Sending belongs to the store, not to whatever screen happened to be up
     * when the wearer tapped. Something ticked on the last screen of a shop
     * goes up even though that screen is gone by the time the request is made.
     */
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** One send at a time: two at once would race over the same queue. */
    private val sending = Mutex()

    /**
     * The phone's half arrives on a background service and is written down
     * rather than handed over, so the app listens for it. Held as a field:
     * what registers this keeps only a weak reference.
     */
    private val watcher = Pairing.watch(ctx) { key ->
        when (key) {
            Pairing.KEY_COOK -> _state.update { it.copy(cooks = Pairing.cooks(ctx)) }
            Pairing.KEY_TIMERS -> _state.update { it.copy(timers = Pairing.timers(ctx)) }
            Pairing.KEY_URL, Pairing.KEY_TOKEN ->
                _state.update { it.copy(paired = Pairing.config(ctx) != null) }
        }
    }

    private val today: String get() = LocalDate.now().toString()

    init {
        restore()
    }

    /** Draw whatever the watch last saw, before anything touches the network. */
    private fun restore() {
        _state.update {
            it.copy(
                items = Pairing.list(ctx)?.let { body -> Kitchen.items(body) }.orEmpty(),
                cooks = Pairing.cooks(ctx),
                recipes = readRecipes(),
                timers = Pairing.timers(ctx),
                pending = Pairing.outbox(ctx).size,
            )
        }
    }

    /**
     * Catch up with the server: send anything waiting, then read the list
     * back, and the recipe too when the phone has put you in a cook.
     */
    suspend fun refresh(quiet: Boolean = false) {
        val cfg = Pairing.pullFromPhone(ctx) ?: run {
            _state.update { it.copy(paired = false) }
            return
        }
        _state.update { it.copy(paired = true, loading = !quiet, error = null) }
        flush(cfg)
        try {
            val body = CookApi.list(cfg)
            Pairing.putList(ctx, body)
            val waiting = Pairing.outbox(ctx)
            // Anything still waiting is the watch's own and newer than what
            // came back: keep it on screen rather than letting the server's
            // answer untick it in front of the wearer.
            val shown = Kitchen.items(body).map { item ->
                val mine = waiting.firstOrNull { it.kind == Pairing.Op.CHECK && it.itemId == item.id }
                if (mine == null) item else item.copy(checked = mine.checked)
            }
            readRecipes(cfg)
            _state.update {
                it.copy(
                    loading = false, offline = false, error = null,
                    items = shown, pending = waiting.size,
                )
            }
            redrawSurfaces()
        } catch (e: Exception) {
            handle(e, quiet)
        }
    }

    /** Whatever recipes the watch has already been given, off the disk. */
    private fun readRecipes(): Map<Long, Kitchen.Recipe> =
        Pairing.cooks(ctx).mapNotNull { cook ->
            Pairing.recipe(ctx, cook.serverRecipeId)
                ?.let { Kitchen.recipe(it) }
                ?.let { cook.serverRecipeId to it }
        }.toMap()

    /**
     * The recipe behind each cook, fetched once and kept. Only what is missing
     * is asked for, so a second dish costs one request and a glance at a cook
     * you are already in costs none.
     */
    private suspend fun readRecipes(cfg: Pairing.Config) {
        val cooks = Pairing.cooks(ctx)
        val have = _state.value.recipes.toMutableMap()
        for (cook in cooks) {
            if (have.containsKey(cook.serverRecipeId)) continue
            runCatching {
                val body = CookApi.recipe(cfg, cook.serverRecipeId)
                Pairing.putRecipe(ctx, cook.serverRecipeId, body)
                Kitchen.recipe(body)?.let { have[cook.serverRecipeId] = it }
            }
        }
        val live = cooks.map { it.serverRecipeId }.toSet()
        have.keys.retainAll(live)
        Pairing.forgetRecipesExcept(ctx, live)
        _state.update { it.copy(cooks = cooks, recipes = have.toMap()) }
    }

    // ── The shopping list ────────────────────────────────────────────────

    /** Into the basket, or back out of it. */
    fun check(item: Kitchen.Item, checked: Boolean) {
        _state.update { s ->
            s.copy(
                items = s.items.map { if (it.id == item.id) it.copy(checked = checked) else it },
                flash = null,
            )
        }
        Pairing.putList(ctx, listBody())
        Pairing.queue(ctx, Pairing.Op(Pairing.Op.CHECK, itemId = item.id, checked = checked))
        _state.update { it.copy(pending = Pairing.outbox(ctx).size) }
        redrawSurfaces()
        send()
    }

    /** What the watch is showing, as the server would have sent it. */
    private fun listBody(): String {
        val arr = org.json.JSONArray()
        for (item in _state.value.items) {
            arr.put(
                org.json.JSONObject()
                    .put("id", item.id).put("name", item.name)
                    .put("quantity", item.qty).put("unit", item.unit)
                    .put("aisle", item.aisle).put("checked", if (item.checked) 1 else 0)
                    .put("recipe_name", item.from)
            )
        }
        return arr.toString()
    }

    // ── The cook ─────────────────────────────────────────────────────────

    /** Tick a step off, or put it back. The phone sees it too. */
    fun tickStep(serverRecipeId: Long, index: Int, done: Boolean) {
        change(serverRecipeId) { cook ->
            cook.copy(steps = if (done) cook.steps + index else cook.steps - index)
        }
    }

    /** Tick an ingredient off as it goes in. */
    fun tickIngredient(serverRecipeId: Long, key: String, done: Boolean) {
        change(serverRecipeId) { cook ->
            cook.copy(ingredients = if (done) cook.ingredients + key else cook.ingredients - key)
        }
    }

    private fun change(serverRecipeId: Long, edit: (Pairing.Cook) -> Pairing.Cook) {
        val cooks = _state.value.cooks
        if (cooks.none { it.serverRecipeId == serverRecipeId }) return
        // The whole list goes back, with this one changed. Sending only the
        // dish you touched would tell the phone the others had ended.
        val next = cooks.map { if (it.serverRecipeId == serverRecipeId) edit(it) else it }
        Pairing.publishCooks(ctx, next)
        _state.update { it.copy(cooks = Pairing.cooks(ctx)) }
    }

    /**
     * Cooked. It goes into the diary the same way anything else does, queued
     * if there is no signal, and that dish is over on both devices. Anything
     * else you have on the go carries on.
     */
    fun cooked(serverRecipeId: Long) {
        val cooks = _state.value.cooks
        if (cooks.none { it.serverRecipeId == serverRecipeId }) return
        Pairing.queue(ctx, Pairing.Op(Pairing.Op.COOKED, recipeId = serverRecipeId, date = today))
        Pairing.publishCooks(ctx, cooks.filterNot { it.serverRecipeId == serverRecipeId })
        _state.update {
            it.copy(
                cooks = Pairing.cooks(ctx),
                recipes = it.recipes - serverRecipeId,
                pending = Pairing.outbox(ctx).size,
                flash = "Cooked",
            )
        }
        Pairing.forgetRecipesExcept(ctx, _state.value.cooks.map { c -> c.serverRecipeId }.toSet())
        redrawSurfaces()
        send()
    }

    // ── Timers ───────────────────────────────────────────────────────────

    fun startTimer(label: String, seconds: Int) {
        if (seconds <= 0) return
        val now = System.currentTimeMillis()
        val kept = Pairing.timers(ctx).filterNot { it.done(now) }
        // A small id, reused once a timer is gone, so the alarm that belongs
        // to it can be cancelled by name.
        val id = (1..8).firstOrNull { candidate -> kept.none { it.id == candidate } } ?: return
        val timer = Pairing.Timer(id, label, seconds, now + seconds * 1000L)
        Pairing.putTimers(ctx, kept + timer)
        KitchenAlarm.schedule(ctx, id, timer.endsAt)
        // No word about it: the screen that opens next is the timer itself.
        _state.update { it.copy(timers = Pairing.timers(ctx)) }
    }

    fun stopTimer(id: Int) {
        KitchenAlarm.cancel(ctx, id)
        Pairing.putTimers(ctx, Pairing.timers(ctx).filterNot { it.id == id })
        _state.update { it.copy(timers = Pairing.timers(ctx)) }
    }

    /** Drop the ones that have rung, so the screen matches the clock. */
    fun tidyTimers() {
        val now = System.currentTimeMillis()
        val live = Pairing.timers(ctx).filterNot { it.done(now) }
        if (live.size != _state.value.timers.size) {
            Pairing.putTimers(ctx, live)
            _state.update { it.copy(timers = live) }
        }
    }

    // ── Sending ──────────────────────────────────────────────────────────

    private fun send() {
        val cfg = Pairing.config(ctx) ?: return
        work.launch { flush(cfg) }
    }

    suspend fun flush(cfg: Pairing.Config): Boolean = sending.withLock { flushOnce(cfg) }

    private suspend fun flushOnce(cfg: Pairing.Config): Boolean {
        val waiting = Pairing.outbox(ctx)
        if (waiting.isEmpty()) return true
        val sent = mutableListOf<Pairing.Op>()
        try {
            for (op in waiting) {
                when (op.kind) {
                    Pairing.Op.CHECK -> CookApi.check(cfg, op.itemId, op.checked)
                    Pairing.Op.COOKED -> CookApi.cooked(cfg, op.recipeId, op.date)
                    else -> {}
                }
                sent.add(op)
            }
        } catch (e: Exception) {
            forget(sent)
            handle(e, quiet = false)
            return false
        }
        // Only what actually went up comes off the queue. Anything ticked
        // while this was in the air is a later entry and stays.
        forget(sent)
        _state.update { it.copy(pending = Pairing.outbox(ctx).size, offline = false, error = null) }
        return true
    }

    private fun forget(sent: List<Pairing.Op>) {
        if (sent.isEmpty()) return
        val seqs = sent.map { it.seq }.toSet()
        Pairing.writeOutbox(ctx, Pairing.outbox(ctx).filterNot { it.seq in seqs })
        _state.update { it.copy(pending = Pairing.outbox(ctx).size) }
    }

    fun clearFlash() {
        _state.update { if (it.flash == null) it else it.copy(flash = null) }
    }

    private fun handle(e: Exception, quiet: Boolean) {
        if (e is CookApi.ApiError && (e.code == 401 || e.code == 403)) {
            // The token expired or was revoked. Saying "pair from your phone"
            // is the only useful thing here, and the phone hands over a fresh
            // one next time it is opened. What is waiting is kept.
            Pairing.forget(ctx)
            _state.update { it.copy(paired = false, loading = false, error = null) }
            return
        }
        val offline = e !is CookApi.ApiError
        _state.update {
            it.copy(
                loading = false,
                offline = offline,
                error = if (offline || quiet) null else (e.message ?: "Couldn't reach CookTrace"),
            )
        }
    }

    /**
     * The tile and the watch face read the same saved list, so they are told
     * whenever it changes rather than waiting for their own schedule.
     */
    private fun redrawSurfaces() {
        KitchenTileService.refresh(ctx)
        ToBuyComplicationService.refresh(ctx)
    }
}
