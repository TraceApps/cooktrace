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

    /**
     * A string from JSON, with nothing in it when there is nothing there.
     *
     * Android's own JSON reader answers a field that is explicitly null with
     * the four letters "null" rather than an empty string, and the reference
     * implementation that unit tests run against does not, so this is a bug
     * that passes every test and then shows the word "null" on a watch. A
     * shopping row with no aisle is exactly that case.
     */
    fun text(o: JSONObject, key: String): String {
        if (o.isNull(key)) return ""
        val value = o.optString(key)
        return if (value == "null") "" else value.trim()
    }

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
            val name = text(o, "name")
            if (name.isBlank()) return@mapNotNull null
            Item(
                id = o.optLong("id"),
                name = name,
                qty = number(o.opt("quantity")),
                unit = text(o, "unit"),
                aisle = text(o, "aisle"),
                checked = o.optInt("checked", 0) == 1 || o.optBoolean("checked", false),
                from = text(o, "recipe_name"),
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
            name = text(o, "name").ifBlank { "Recipe" },
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
                val name = text(it, "name")
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
                        unit = text(it, "unit"),
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
            val body = text(s, "text")
            if (body.isBlank()) continue
            out.add(Step(index = out.size, title = text(s, "title"), text = body))
        }
        return out
    }

    // ── Timers a step asks for ───────────────────────────────────────────

    /**
     * The times a step mentions, in seconds. "Simmer for 20 minutes" is a
     * timer waiting to be offered, and asking the wearer to dial 20 minutes
     * by hand when the step already says so is work for nothing.
     */
    fun timesIn(text: String): List<Int> = stepTimes(text).map { it.second }.distinct().take(3)

    /**
     * Every time a step mentions, as written and in seconds, in every language
     * in time-words.json at once: a recipe is written in its cook's language,
     * whatever language the phone is in. The phone finds the same ones
     * (src/lib/parseTimes.js), and scripts/step-times.json holds what both
     * must find; KitchenTest runs the watch against it.
     */
    fun stepTimes(text: String): List<Pair<String, Int>> {
        if (text.isBlank()) return emptyList()
        val w = words
        // Java's \s is ASCII, and French sets a unit off with a no-break
        // space ("20 min"). One character for one, so where a time sits in
        // the text is still where it sits in the step.
        val plain = text.replace('\u00A0', ' ').replace('\u202F', ' ').replace('\u2009', ' ')
        val out = mutableListOf<Pair<String, Int>>()
        var from = 0
        while (from <= plain.length) {
            val m = w.pattern.find(plain, from) ?: break
            val at = m.range.first
            // A time starts its own word: not the "0 min" inside "20 min".
            if (at > 0 && BEFORE.matches(plain[at - 1].toString())) {
                from = at + 1
                continue
            }
            from = m.range.last + 1
            val seconds = w.seconds(m.value.lowercase())
            if (seconds in 1..86_400) out.add(text.substring(at, m.range.last + 1) to seconds)
        }
        return out
    }

    private val BEFORE = Regex("""[\p{L}\p{N}.,/]""")

    private val words: TimeWords by lazy {
        val raw = Kitchen::class.java.getResourceAsStream("/time-words.json")
            ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
        TimeWords(runCatching { JSONObject(raw.orEmpty()) }.getOrElse { JSONObject() })
    }

    /** The patterns for the words of every language, as the phone builds them. */
    private class TimeWords(json: JSONObject) {
        private val langs = json.keys().asSequence()
            .filterNot { it.startsWith("_") }
            .mapNotNull { json.optJSONObject(it) }
            .toList()

        /** Every language's words of a kind, longest first, as one alternation. */
        private fun any(kind: String): String {
            val all = langs.flatMap { l ->
                val a = l.optJSONArray(kind) ?: return@flatMap emptyList()
                (0 until a.length()).map { a.optString(it).lowercase() }
            }.filter { it.isNotEmpty() }.distinct()
            return if (all.isEmpty()) "(?!)"
            else all.sortedByDescending { it.length }.joinToString("|", "(?:", ")") { Regex.escape(it) }
        }

        private val phrases: Map<String, Int> = langs.flatMap { l ->
            val p = l.optJSONObject("phrases") ?: return@flatMap emptyList()
            p.keys().asSequence().map { it.lowercase() to p.optInt(it) }.toList()
        }.toMap()

        private val num = """(?:\d+\s+\d+/\d+|\d+/\d+|\d+(?:[.,]\d+)?)"""
        private val hour = any("hour")
        // An abbreviation can take a dot before its minutes ("1 Std. 30 Min."),
        // where a whole word's dot ends the sentence.
        private val hourAbbr = any("hour_abbr")
        private val min = any("minute")
        private val sec = any("second")
        private val one = any("one")
        private val end = """(?!\p{L})"""
        private val join = """(?:\s*(?:,|${any("and")}(?!\p{L}))\s*|\s*)"""
        private val hourOf = """(?:$hour$end|$hourAbbr\.)"""
        private val range = """\s*(?:-|\u2013|\u2014|${any("to")}(?!\p{L}))\s*"""
        private val andHalf = """\s*${any("and_half")}(?!\p{L})"""
        private val phrase = if (phrases.isEmpty()) "(?!)"
            else phrases.keys.sortedByDescending { it.length }.joinToString("|", "(?:", ")(?!\\p{L})") { Regex.escape(it) }

        val pattern = Regex(
            listOf(
                phrase,
                "(?:$num\\s*|$one\\s+)$hour$end$andHalf",
                "$num\\s*$hourOf$join$num\\s*$min$end",
                // French "1h30", "2 h 15".
                """\d+\s*h(?:\d{1,2}|\s+\d{2})(?![\d\p{L}]|[.,]\d)""",
                "$num$range$num\\s*(?:$hour|$min|$sec)$end",
                "$num\\s*(?:$hour|$min|$sec)$end",
                "$one\\s+$hour$end",
            ).joinToString("|", "(?:", ")"),
            RegexOption.IGNORE_CASE,
        )

        private val halfRe = Regex("^($num|$one)\\s*$hour$end$andHalf$")
        private val hourMinRe = Regex("^($num)\\s*$hourOf$join($num)\\s*$min$")
        private val frenchRe = Regex("""^(\d+)\s*h\s*(\d{1,2})$""")
        private val rangeRe = Regex("^($num)$range($num)\\s*(\\p{L}+)$")
        private val singleRe = Regex("^($num|$one)\\s*(\\p{L}+)$")
        private val oneRe = Regex("^$one$")
        private val hourRe = Regex("^$hour$")
        private val minRe = Regex("^$min$")

        private fun number(s: String): Double {
            val t = s.trim()
            Regex("""^(\d+)\s+(\d+)/(\d+)$""").find(t)?.let { m ->
                val (w, n, d) = m.destructured
                if (d.toDouble() > 0) return w.toDouble() + n.toDouble() / d.toDouble()
            }
            Regex("""^(\d+)/(\d+)$""").find(t)?.let { m ->
                val (n, d) = m.destructured
                if (d.toDouble() > 0) return n.toDouble() / d.toDouble()
            }
            if (oneRe.matches(t)) return 1.0
            return t.replace(',', '.').toDoubleOrNull() ?: Double.NaN
        }

        private fun unit(u: String): Int = when {
            hourRe.matches(u) -> 3600
            minRe.matches(u) -> 60
            else -> 1
        }

        /** What a matched time comes to, from its lowercased text. */
        fun seconds(text: String): Int {
            phrases[text]?.let { return it }
            halfRe.find(text)?.let { return Math.round((number(it.groupValues[1]) + 0.5) * 3600).toInt() }
            hourMinRe.find(text)?.let {
                return Math.round(number(it.groupValues[1]) * 3600 + number(it.groupValues[2]) * 60).toInt()
            }
            frenchRe.find(text)?.let { return it.groupValues[1].toInt() * 3600 + it.groupValues[2].toInt() * 60 }
            rangeRe.find(text)?.let {
                val low = minOf(number(it.groupValues[1]), number(it.groupValues[2]))
                return Math.round(low * unit(it.groupValues[3])).toInt()
            }
            singleRe.find(text)?.let { return Math.round(number(it.groupValues[1]) * unit(it.groupValues[2])).toInt() }
            return 0
        }
    }

    /** Counting down, as a watch shows it: 20:00, 1:05:00. */
    fun clock(seconds: Int): String {
        val safe = maxOf(0, seconds)
        val h = safe / 3600
        val m = (safe % 3600) / 60
        val s = safe % 60
        return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}"
        else "$m:${s.toString().padStart(2, '0')}"
    }

    /**
     * How near a timer is to ringing, for the colour of the ring around it.
     *
     * The two halves are measured differently on purpose. Whether something
     * needs you NOW is a question about the clock: under a minute is under a
     * minute, whether it is an egg or a joint of beef. Whether it is getting
     * on is partly about proportion, so a long braise turns amber when it is
     * down to its last third rather than staying green for hours and then
     * flipping at the death.
     *
     * Measuring both by proportion was the first thing I tried, and it called
     * a three-hour braise urgent with five minutes to go, which is wrong by a
     * factor of five.
     */
    enum class Urgency { CALM, SOON, NOW }

    fun urgency(secondsLeft: Int, total: Int): Urgency {
        val left = maxOf(0, secondsLeft)
        val fraction = left.toDouble() / maxOf(1, total)
        return when {
            left <= 60 -> Urgency.NOW
            left <= 300 || fraction <= 0.30 -> Urgency.SOON
            else -> Urgency.CALM
        }
    }

    /** "20 min", for a button offering a timer the step asked for. */
    fun duration(seconds: Int): String = when {
        seconds % 3600 == 0 && seconds >= 3600 -> "${seconds / 3600} hr"
        seconds >= 60 -> "${seconds / 60} min"
        else -> "$seconds sec"
    }
}
