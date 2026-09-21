package com.cooktrace.app.wear

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the watch understands about a kitchen: a shopping list, and a recipe
 * reduced to the parts you need while your hands are busy.
 *
 * Plain data in, plain data out, so it can be tested without a watch
 * (src/test). CookApi does the talking, CookStore holds the state,
 * MainActivity draws it.
 *
 * The shapes are the server's own. A shopping row carries a name, an amount
 * and an aisle; a recipe carries grouped ingredients and steps of
 * `{title, text}`, which is what makes one step at a time possible at all.
 */
object Kitchen {

    // ── The shopping list ────────────────────────────────────────────────

    data class Item(
        val id: Long,
        val name: String,
        val qty: String,
        val unit: String,
        val aisle: String,
        val checked: Boolean,
        /** The recipe it came from, when it was added from one. */
        val from: String,
    ) {
        /** "2 cups", or nothing when the row is just a name. */
        val amount: String get() = listOf(qty, unit).filter { it.isNotBlank() }.joinToString(" ")
    }

    fun items(body: String): List<Item> {
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val name = o.optString("name").trim()
            if (name.isBlank()) return@mapNotNull null
            Item(
                id = o.optLong("id"),
                name = name,
                qty = number(o.opt("quantity")),
                unit = o.optString("unit").orEmpty().trim(),
                aisle = o.optString("aisle").orEmpty().trim(),
                checked = o.optInt("checked", 0) == 1 || o.optBoolean("checked", false),
                from = o.optString("recipe_name").orEmpty().trim(),
            )
        }
    }

    /**
     * The list as you walk a shop: by aisle, with what is already in the
     * basket at the bottom. The server sorts it this way too, so this only
     * has to keep that order while the watch ticks things off.
     */
    fun aisles(items: List<Item>): List<Pair<String, List<Item>>> =
        items.filterNot { it.checked }
            .groupBy { it.aisle.ifBlank { "Anything else" } }
            .toList()
            .sortedBy { if (it.first == "Anything else") "zzzz" else it.first.lowercase() }

    /** A number the way a person writes it: 2 rather than 2.0, 0.5 as it is. */
    fun number(raw: Any?): String {
        val value = when (raw) {
            null, JSONObject.NULL -> return ""
            is Number -> raw.toDouble()
            is String -> raw.trim().ifBlank { return "" }.toDoubleOrNull() ?: return raw.trim()
            else -> return ""
        }
        if (value <= 0) return ""
        val rounded = Math.round(value * 100.0) / 100.0
        return if (rounded % 1.0 == 0.0) rounded.toLong().toString() else rounded.toString()
    }

    // ── A recipe, as far as a wrist needs it ─────────────────────────────

    data class Ingredient(val key: String, val qty: String, val unit: String, val name: String) {
        val amount: String get() = listOf(qty, unit).filter { it.isNotBlank() }.joinToString(" ")
        /** "2 cups flour", or just "flour". */
        val line: String get() = listOf(amount, name).filter { it.isNotBlank() }.joinToString(" ")
    }

    data class Step(val index: Int, val title: String, val text: String) {
        /**
         * What a list row shows: the step's own title when it has one, and
         * otherwise its first sentence, which is how a recipe writer tends to
         * open a step. Long enough to hold an ordinary sentence, short enough
         * that a list of them can be scanned rather than read.
         */
        val heading: String
            get() = title.ifBlank {
                val first = text.trim().split(Regex("(?<=[.!?])\\s+")).firstOrNull().orEmpty()
                if (first.length in 1..60) first else text.trim().take(52).trim() + "…"
            }
    }

    data class Recipe(
        val id: Long,
        val name: String,
        val servings: Int,
        val ingredients: List<Ingredient>,
        val steps: List<Step>,
    )

    fun recipe(body: String): Recipe? {
        val o = runCatching { JSONObject(body) }.getOrNull() ?: return null
        val id = o.optLong("id", 0L)
        if (id <= 0) return null
        return Recipe(
            id = id,
            name = o.optString("name").ifBlank { "Recipe" },
            servings = o.optInt("servings", 0),
            ingredients = ingredients(o.optJSONArray("ingredients")),
            steps = steps(o.optJSONArray("steps")),
        )
    }

    /**
     * Ingredients arrive in groups ("For the sauce"), which matter on a page
     * and not on a wrist: what you want while cooking is one list to tick
     * off. The group name is folded into nothing and the items are flattened.
     */
    private fun ingredients(groups: JSONArray?): List<Ingredient> {
        val out = mutableListOf<Ingredient>()
        for (g in 0 until (groups?.length() ?: 0)) {
            val group = groups!!.optJSONObject(g) ?: continue
            val items = group.optJSONArray("items") ?: continue
            for (i in 0 until items.length()) {
                val it = items.optJSONObject(i) ?: continue
                val name = it.optString("name").trim()
                if (name.isBlank()) continue
                out.add(
                    Ingredient(
                        // Ingredients carry no id of their own, so where they
                        // sit is what identifies them between the phone and
                        // the watch. The phone writes it exactly this way
                        // (checkKey in RecipeView), and the two must match or
                        // a tick on one would mean nothing on the other.
                        key = "$g-$i",
                        qty = number(it.opt("qty")),
                        unit = it.optString("unit").orEmpty().trim(),
                        name = name,
                    )
                )
            }
        }
        return out
    }

    private fun steps(arr: JSONArray?): List<Step> {
        val out = mutableListOf<Step>()
        for (i in 0 until (arr?.length() ?: 0)) {
            val s = arr!!.optJSONObject(i) ?: continue
            val text = s.optString("text").trim()
            if (text.isBlank()) continue
            out.add(Step(index = out.size, title = s.optString("title").orEmpty().trim(), text = text))
        }
        return out
    }

    // ── Timers a step asks for ───────────────────────────────────────────

    private val DURATION = Regex(
        """(\d+(?:[.,]\d+)?)\s*(?:-\s*\d+\s*)?(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * The times a step mentions, in seconds. "Simmer for 20 minutes" is a
     * timer waiting to be offered, and asking the wearer to dial 20 minutes
     * by hand when the step already says so is work for nothing.
     */
    fun timesIn(text: String): List<Int> = DURATION.findAll(text).mapNotNull { m ->
        val value = m.groupValues[1].replace(',', '.').toDoubleOrNull() ?: return@mapNotNull null
        val unit = m.groupValues[2].lowercase()
        val seconds = when {
            unit.startsWith("h") -> value * 3600
            unit.startsWith("m") -> value * 60
            else -> value
        }
        seconds.toInt().takeIf { it in 1..86_400 }
    }.distinct().take(3).toList()

    /** Counting down, as a watch shows it: 20:00, 1:05:00. */
    fun clock(seconds: Int): String {
        val safe = maxOf(0, seconds)
        val h = safe / 3600
        val m = (safe % 3600) / 60
        val s = safe % 60
        return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}"
        else "$m:${s.toString().padStart(2, '0')}"
    }

    /** "20 min", for a button offering a timer the step asked for. */
    fun duration(seconds: Int): String = when {
        seconds % 3600 == 0 && seconds >= 3600 -> "${seconds / 3600} hr"
        seconds >= 60 -> "${seconds / 60} min"
        else -> "$seconds sec"
    }
}
