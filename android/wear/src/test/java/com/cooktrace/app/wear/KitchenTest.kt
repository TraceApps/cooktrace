package com.cooktrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decisions the watch makes on its own: what a shopping row says, how a
 * recipe becomes something a wrist can use, and which times a step is asking
 * you to set. Plain data in and plain data out, so it is tested here rather
 * than in a kitchen.
 */
class KitchenTest {

    private val list = """
        [{"id":1,"name":"Flour","quantity":500,"unit":"g","aisle":"Baking","checked":0,"recipe_name":"Focaccia"},
         {"id":2,"name":"Salt","quantity":null,"unit":null,"aisle":"Baking","checked":0,"recipe_name":""},
         {"id":3,"name":"Milk","quantity":1.5,"unit":"l","aisle":"Dairy","checked":0,"recipe_name":""},
         {"id":4,"name":"Olives","quantity":2,"unit":"","aisle":"","checked":1,"recipe_name":""}]
    """.trimIndent()

    private val recipe = """
        {"id":7,"name":"Focaccia","servings":4,
         "ingredients":[
           {"name":"Dough","items":[{"qty":500,"unit":"g","name":"Flour"},{"qty":"1.5","unit":"tsp","name":"Salt"}]},
           {"name":"To finish","items":[{"qty":2,"unit":"tbsp","name":"Olive oil"}]}],
         "steps":[
           {"title":"Mix","text":"Whisk the flour and salt, then pour in the water."},
           {"title":"","text":"Cover and leave to rise for 90 minutes, until doubled."},
           {"title":"Bake","text":"Bake for 20-25 minutes at 220C, then rest 10 min before cutting."}]}
    """.trimIndent()

    @Test
    fun `a shopping row reads the way it is written`() {
        val items = Kitchen.items(list)
        assertEquals(4, items.size)
        assertEquals("500 g", items[0].amount)
        // A row with no amount says nothing rather than "0".
        assertEquals("", items[1].amount)
        // And a half is a half, not 1.5000000001.
        assertEquals("1.5 l", items[2].amount)
        assertTrue(items[3].checked)
    }

    @Test
    fun `the list is walked by aisle, with the basket left out`() {
        val aisles = Kitchen.aisles(Kitchen.items(list))
        assertEquals(listOf("Baking", "Dairy"), aisles.map { it.first })
        assertEquals(2, aisles[0].second.size)
        // What is already in the basket is not something to walk to.
        assertTrue(aisles.none { (_, items) -> items.any { it.checked } })
    }

    @Test
    fun `an aisle nobody named goes last`() {
        val unnamed = """[{"id":9,"name":"Batteries","aisle":"","checked":0}]"""
        val aisles = Kitchen.aisles(Kitchen.items(unnamed))
        assertEquals("Anything else", aisles.single().first)
    }

    @Test
    fun `a recipe becomes one list of things to tick off`() {
        val r = Kitchen.recipe(recipe)!!
        assertEquals("Focaccia", r.name)
        // Groups are for a page, not a wrist: three ingredients, one list.
        assertEquals(3, r.ingredients.size)
        assertEquals("500 g Flour", r.ingredients[0].line)
        assertEquals("1.5 tsp Salt", r.ingredients[1].line)
        // The keys are the phone's own, so a tick means the same on both.
        assertEquals(listOf("0-0", "0-1", "1-0"), r.ingredients.map { it.key })
        assertEquals(3, r.steps.size)
    }

    @Test
    fun `a step without a title still has something to call it`() {
        val r = Kitchen.recipe(recipe)!!
        assertEquals("Mix", r.steps[0].heading)
        // The first sentence, when it is short enough to be a heading.
        assertEquals("Cover and leave to rise for 90 minutes, until doubled.", r.steps[1].heading)
    }

    @Test
    fun `a step that names a time is offering a timer`() {
        assertEquals(listOf(5400), Kitchen.timesIn("Cover and leave to rise for 90 minutes, until doubled."))
        // A range offers the first number, and the second time in the step too.
        assertEquals(listOf(1200, 600), Kitchen.timesIn("Bake for 20-25 minutes at 220C, then rest 10 min before cutting."))
        assertEquals(listOf(7200), Kitchen.timesIn("Leave for 2 hours"))
        assertEquals(listOf(30), Kitchen.timesIn("Blitz for 30 seconds"))
        // A temperature is not a time.
        assertTrue(Kitchen.timesIn("Heat the oven to 220C").isEmpty())
    }

    @Test
    fun `times are written the way a button should read`() {
        assertEquals("20 min", Kitchen.duration(1200))
        assertEquals("2 hr", Kitchen.duration(7200))
        assertEquals("30 sec", Kitchen.duration(30))
    }

    @Test
    fun `a countdown reads as a clock`() {
        assertEquals("20:00", Kitchen.clock(1200))
        assertEquals("1:30:00", Kitchen.clock(5400))
        assertEquals("0:05", Kitchen.clock(5))
        assertEquals("0:00", Kitchen.clock(-9))
    }

    @Test
    fun `a timer knows where it stands without anyone counting`() {
        val now = 1_700_000_000_000L
        val timer = Pairing.Timer(1, "Step 2", 1200, now + 600_000)
        assertEquals(600, timer.secondsLeft(now))
        assertFalse(timer.done(now))
        assertTrue(timer.done(now + 600_001))
        assertEquals(0, timer.secondsLeft(now + 900_000))
    }

    @Test
    fun `what is waiting survives being written down, whichever kind it is`() {
        val tick = Pairing.Op(Pairing.Op.CHECK, itemId = 3, checked = true, seq = 7)
        assertEquals(tick, Pairing.Op.from(tick.toJson()))
        assertEquals("check:3", tick.key)

        val cooked = Pairing.Op(Pairing.Op.COOKED, recipeId = 7, date = "2026-09-21", seq = 8)
        val back = Pairing.Op.from(cooked.toJson())
        assertEquals(cooked, back)
        assertEquals("cooked:7:2026-09-21", back.key)
        assertEquals(8L, back.seq)
    }

    @Test
    fun `a field that is null reads as nothing, never as the word null`() {
        // Android's JSON reader answers an explicitly null field with the four
        // letters "null", where the one these tests run against answers with
        // an empty string. Both are handled, or a shopping row with no aisle
        // puts the word "null" on the watch, which is what it did.
        val nulls = """[{"id":1,"name":"Bread","quantity":null,"unit":null,"aisle":null,"checked":0,"recipe_name":null}]"""
        val item = Kitchen.items(nulls).single()
        assertEquals("", item.unit)
        assertEquals("", item.aisle)
        assertEquals("", item.from)
        assertEquals("", item.amount)
        // And the aisle it falls into is the named one, not "null".
        assertEquals("Anything else", Kitchen.aisles(listOf(item)).single().first)

        // The same anywhere else a string comes out of JSON.
        val o = org.json.JSONObject("""{"a":null,"b":"null","c":" x "}""")
        assertEquals("", Kitchen.text(o, "a"))
        assertEquals("", Kitchen.text(o, "b"))
        assertEquals("x", Kitchen.text(o, "c"))
        assertEquals("", Kitchen.text(o, "missing"))
    }

    @Test
    fun `nothing sensible in, nothing silly out`() {
        assertTrue(Kitchen.items("not json").isEmpty())
        assertNull(Kitchen.recipe("{}"))
        assertNull(Kitchen.recipe("nonsense"))
        assertTrue(Kitchen.recipe("""{"id":1,"name":"Empty"}""")!!.steps.isEmpty())
    }
}
