package com.cooktrace.app.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavHostController
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SplitCheckboxButton
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TitleCard
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * CookTrace on the wrist: the shopping list while your hands are full in an
 * aisle, and the cook you are in while they are covered in flour.
 *
 * The list is home, because that is the thing you use every week. A cook
 * arrives when you press Cook on the phone, which is where choosing a recipe
 * belongs; the watch is what you touch once your hands are dirty.
 */
class MainActivity : ComponentActivity() {

    private lateinit var store: CookStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = CookStore(applicationContext)
        setContent { WearApp(store) }
    }

    override fun onResume() {
        super.onResume()
        // Coming back from the watch face should show the list as it stands,
        // and is the moment to send anything ticked while there was no signal.
        lifecycleScope.launch { store.refresh() }
    }
}

/**
 * Work that only happens while the app is actually in front of you.
 *
 * A LaunchedEffect lives as long as the composition, and on a watch the
 * composition outlives the screen by a long way: drop your wrist and the app
 * stays top of the stack, just not visible. Anything ticking or polling in
 * one of those carries on all night.
 */
@Composable
private fun WhileWatching(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner, *keys) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { block() }
    }
}

@Composable
fun WearApp(store: CookStore) {
    val nav = rememberSwipeDismissableNavController()
    val state by store.state.collectAsStateWithLifecycle()

    // While the app is open, keep up with the phone and the clock.
    WhileWatching(state.paired) {
        while (true) {
            delay(30_000)
            store.tidyTimers()
            if (state.paired) store.refresh(quiet = true)
        }
    }

    val flash = state.flash
    if (flash != null) {
        LaunchedEffect(flash) {
            delay(1200)
            store.clearFlash()
        }
        AppScaffold {
            Box(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    flash + (if (state.offline || state.pending > 0) ", waiting for a connection" else ""),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.titleMedium,
                )
            }
        }
        return
    }

    AppScaffold {
        SwipeDismissableNavHost(navController = nav, startDestination = "list") {
            composable("list") { ShoppingScreen(store, nav) }
            composable("cook") { CookScreen(store, nav) }
            composable("ingredients") { IngredientsScreen(store) }
            composable("step/{index}") { entry ->
                StepScreen(store, nav, entry.arguments?.getString("index")?.toIntOrNull() ?: 0)
            }
            composable("timers") { TimersScreen(store) }
        }
    }
}

/** A list the crown scrolls, not only a finger. */
@Composable
private fun CrownColumn(
    listState: ScalingLazyListState,
    content: ScalingLazyListScope.() -> Unit,
) {
    val focus = remember { FocusRequester() }
    ScalingLazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .rotaryScrollable(RotaryScrollableDefaults.behavior(listState), focusRequester = focus),
        content = content,
    )
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

/**
 * The shopping list, by aisle, which is the shape of a shop. Home, because
 * it is the thing you use weekly with a trolley in one hand.
 */
@Composable
private fun ShoppingScreen(store: CookStore, nav: NavHostController) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()

    ScreenScaffold(scrollState = listState) {
        if (!state.paired) {
            Box(
                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 28.dp),
                contentAlignment = Alignment.Center,
            ) {
                Message(
                    title = "Pair from your phone",
                    body = "Open CookTrace on your phone and sign in. The watch pairs itself.",
                )
            }
            return@ScreenScaffold
        }
        CrownColumn(listState) {
            if (state.pending > 0 || state.offline || state.error != null) {
                item { StatusLine(state) }
            }
            // What you are doing right now comes before the list you keep.
            // The list is home because it is what you use every week; a cook
            // in progress is what you are holding a spoon for.
            state.cook?.let { cook ->
                item(key = "cooking") { ListHeader { Text("Cooking") } }
                item(key = "cook") {
                    TitleCard(
                        onClick = { nav.navigate("cook") },
                        // The recipe the watch actually fetched, not the name
                        // that came with the handoff: the page on the phone
                        // can have moved on since.
                        title = {
                            Text(
                                state.recipe?.name ?: cook.name.ifBlank { "Cooking" },
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        val steps = state.recipe?.steps?.size ?: 0
                        Text(if (steps > 0) "${cook.steps.size} of $steps steps done" else "Cooking now")
                    }
                }
            }
            if (state.timers.isNotEmpty()) {
                item(key = "timers") {
                    TitleCard(
                        onClick = { nav.navigate("timers") },
                        title = { Text(if (state.timers.size == 1) "1 timer" else "${state.timers.size} timers") },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        val now = System.currentTimeMillis()
                        Text(Kitchen.clock(state.timers.minOf { it.secondsLeft(now) }) + " on the first")
                    }
                }
            }
            item(key = "shopping") { ListHeader { Text("Shopping") } }
            val aisles = Kitchen.aisles(state.items)
            aisles.forEach { (aisle, items) ->
                item(key = "aisle-$aisle") { ListHeader { Text(aisle, maxLines = 1, overflow = TextOverflow.Ellipsis) } }
                items.forEach { item ->
                    item(key = item.id) {
                        ItemRow(item) { store.check(item, true) }
                    }
                }
            }
            val bought = state.items.filter { it.checked }
            if (bought.isNotEmpty()) {
                item(key = "basket") { ListHeader { Text("${bought.size} in the basket") } }
                bought.forEach { item ->
                    item(key = "b-${item.id}") {
                        ItemRow(item) { store.check(item, false) }
                    }
                }
            }
            if (state.items.isEmpty()) {
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp)) {
                        Message(
                            title = if (state.loading) "Loading" else "Nothing to buy",
                            body = if (state.loading) "" else "What you add on your phone shows up here.",
                        )
                    }
                }
            }
            item {
                Button(
                    onClick = { scope.launch { store.refresh() } },
                    label = { Text(if (state.loading) "Refreshing" else "Refresh") },
                    icon = { Icon(painter = painterResource(R.drawable.ic_refresh), contentDescription = null) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/**
 * One thing to buy. Ticked ones stay, struck through, so the tap is
 * confirmed rather than answered by the row disappearing.
 */
@Composable
private fun ItemRow(item: Kitchen.Item, onToggle: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val toggle = {
        // A tick you can feel, for a glance and a tap in a shop.
        runCatching { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
        onToggle()
    }
    SplitCheckboxButton(
        checked = item.checked,
        onCheckedChange = { toggle() },
        toggleContentDescription = item.name,
        onContainerClick = toggle,
        containerClickLabel = item.name,
        label = {
            Text(
                item.name,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textDecoration = if (item.checked) TextDecoration.LineThrough else null,
                color = if (item.checked) MaterialTheme.colorScheme.onSurfaceVariant else Color.Unspecified,
            )
        },
        secondaryLabel = {
            val detail = listOf(item.amount, item.from).filter { it.isNotBlank() }.joinToString(" · ")
            if (detail.isNotBlank()) Text(detail, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * The cook: what goes in, what to do, and the one button that ends it. The
 * steps are a list you tick off, because that is what tells you where you
 * were when you looked away to stir something.
 */
@Composable
private fun CookScreen(store: CookStore, nav: NavHostController) {
    val state by store.state.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val cook = state.cook
    val recipe = state.recipe

    ScreenScaffold(
        scrollState = listState,
        edgeButton = {
            if (cook != null) {
                EdgeButton(onClick = { store.cooked() }) { Text("I cooked this") }
            }
        },
    ) {
        if (cook == null) {
            Box(modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
                Message(title = "Not cooking", body = "Press Cook on your phone and it turns up here.")
            }
            return@ScreenScaffold
        }
        CrownColumn(listState) {
            item {
                ListHeader {
                    Text(
                        recipe?.name ?: cook.name.ifBlank { "Cooking" },
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            val total = recipe?.steps?.size ?: 0
            if (total > 0) {
                item {
                    Text(
                        "${cook.steps.size} of $total steps done",
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 2.dp),
                    )
                }
            }
            if (recipe != null && recipe.ingredients.isNotEmpty()) {
                item(key = "ings") {
                    TitleCard(
                        onClick = { nav.navigate("ingredients") },
                        title = { Text("Ingredients") },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("${cook.ingredients.size} of ${recipe.ingredients.size} in")
                    }
                }
            }
            if (state.timers.isNotEmpty()) {
                item(key = "timers") {
                    Button(
                        onClick = { nav.navigate("timers") },
                        label = {
                            val now = System.currentTimeMillis()
                            Text(Kitchen.clock(state.timers.minOf { it.secondsLeft(now) }) + " · timers")
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            val steps = recipe?.steps.orEmpty()
            if (steps.isNotEmpty()) {
                // A heading over them, so a list of ticks is plainly the
                // method rather than whatever else it might be.
                item(key = "steps-head") { ListHeader { Text("Steps") } }
            }
            if (steps.isEmpty()) {
                item {
                    Message(
                        title = if (state.loading) "Loading" else "No steps",
                        body = if (state.loading) "" else "This recipe has none written down.",
                    )
                }
            }
            val upTo = steps.firstOrNull { !cook.steps.contains(it.index) }?.index
            steps.forEach { step ->
                item(key = "s-${step.index}") {
                    val done = cook.steps.contains(step.index)
                    SplitCheckboxButton(
                        checked = done,
                        onCheckedChange = { store.tickStep(step.index, !done) },
                        toggleContentDescription = "Step ${step.index + 1}",
                        onContainerClick = { nav.navigate("step/${step.index}") },
                        containerClickLabel = step.heading,
                        label = {
                            Text(
                                (if (step.index == upTo) "→ " else "") + "${step.index + 1}. " + step.heading,
                                maxLines = 3,
                                overflow = TextOverflow.Ellipsis,
                                textDecoration = if (done) TextDecoration.LineThrough else null,
                                color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else Color.Unspecified,
                            )
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

/**
 * One step in full, with any time it mentions offered as a timer. A step
 * that says "simmer for 20 minutes" should not make you dial 20 minutes.
 */
@Composable
private fun StepScreen(store: CookStore, nav: NavHostController, index: Int) {
    val state by store.state.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val step = state.recipe?.steps?.getOrNull(index)
    val done = state.cook?.steps?.contains(index) == true

    ScreenScaffold(
        scrollState = listState,
        edgeButton = {
            if (step != null) {
                EdgeButton(onClick = {
                    store.tickStep(index, !done)
                    nav.popBackStack()
                }) { Text(if (done) "Not done" else "Step done") }
            }
        },
    ) {
        if (step == null) {
            Box(modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
                Message(title = "That step is gone", body = "The recipe changed on your phone.")
            }
            return@ScreenScaffold
        }
        CrownColumn(listState) {
            item { ListHeader { Text("Step ${index + 1}", maxLines = 1) } }
            if (step.title.isNotBlank()) {
                item {
                    Text(
                        step.title,
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            item {
                Text(
                    step.text,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
            Kitchen.timesIn(step.text).forEach { seconds ->
                item(key = "t-$seconds") {
                    Button(
                        onClick = {
                            store.startTimer("Step ${index + 1}", seconds)
                            // Starting a timer should show you the timer.
                            // Confirming it with a word and leaving you where
                            // you were makes you go and find it.
                            nav.navigate("timers")
                        },
                        label = { Text("Start " + Kitchen.duration(seconds)) },
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

/** What goes in, ticked off as it goes in. */
@Composable
private fun IngredientsScreen(store: CookStore) {
    val state by store.state.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val cook = state.cook
    val ingredients = state.recipe?.ingredients.orEmpty()

    ScreenScaffold(scrollState = listState) {
        CrownColumn(listState) {
            item { ListHeader { Text("Ingredients") } }
            if (ingredients.isEmpty()) {
                item { Message(title = "None listed", body = "This recipe has no ingredients written down.") }
            }
            ingredients.forEach { ing ->
                item(key = ing.key) {
                    val done = cook?.ingredients?.contains(ing.key) == true
                    SplitCheckboxButton(
                        checked = done,
                        onCheckedChange = { store.tickIngredient(ing.key, !done) },
                        toggleContentDescription = ing.name,
                        onContainerClick = { store.tickIngredient(ing.key, !done) },
                        containerClickLabel = ing.name,
                        label = {
                            Text(
                                ing.name,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                textDecoration = if (done) TextDecoration.LineThrough else null,
                                color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else Color.Unspecified,
                            )
                        },
                        secondaryLabel = { if (ing.amount.isNotBlank()) Text(ing.amount) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

/** Everything counting down at once, because a kitchen runs more than one. */
@Composable
private fun TimersScreen(store: CookStore) {
    val state by store.state.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }

    WhileWatching(state.timers.size) {
        while (true) {
            now = System.currentTimeMillis()
            store.tidyTimers()
            delay(500)
        }
    }

    ScreenScaffold(scrollState = listState) {
        CrownColumn(listState) {
            item { ListHeader { Text("Timers") } }
            if (state.timers.isEmpty()) {
                item {
                    Message(
                        title = "Nothing counting",
                        body = "A step that mentions a time offers one.",
                    )
                }
            }
            state.timers.sortedBy { it.endsAt }.forEach { timer ->
                item(key = timer.id) {
                    TitleCard(
                        onClick = { store.stopTimer(timer.id) },
                        title = { Text(Kitchen.clock(timer.secondsLeft(now)), maxLines = 1) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            timer.label.ifBlank { "Timer" } + " · tap to stop",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusLine(state: CookStore.State) {
    val text = when {
        state.error != null -> state.error
        state.offline && state.pending > 0 -> "Offline, ${state.pending} waiting"
        state.offline -> "Offline"
        state.pending > 0 -> "${state.pending} waiting"
        else -> ""
    }
    if (text.isBlank()) return
    Text(
        text,
        textAlign = TextAlign.Center,
        color = if (state.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
    )
}

@Composable
private fun Message(title: String, body: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, textAlign = TextAlign.Center, style = MaterialTheme.typography.titleMedium)
        if (body.isNotBlank()) {
            Text(
                body,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
