package com.cooktrace.app.wear

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The watch talking to a CookTrace server: the shopping list, the recipe you
 * are cooking, and the two things a wrist ever writes back, an item ticked
 * off and a recipe logged as cooked.
 *
 * Deliberately small. Browsing, searching and editing stay on the phone,
 * which means this needs four calls and no more.
 */
object CookApi {

    class ApiError(message: String, val code: Int) : Exception(message)

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        // A watch on a kitchen's wifi is slow, not broken; a phone in another
        // room is gone. Long enough for the first, short enough that the
        // second doesn't leave the screen spinning.
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    /** Everything on the list, the server's own order: aisle, then name. */
    suspend fun list(cfg: Pairing.Config): String = send(cfg, "GET", "/api/shopping", null)

    /** One recipe, for the cook the phone handed over. */
    suspend fun recipe(cfg: Pairing.Config, id: Long): String = send(cfg, "GET", "/api/recipes/$id", null)

    /** Into the basket, or back out of it. */
    suspend fun check(cfg: Pairing.Config, id: Long, checked: Boolean): String =
        send(cfg, "PATCH", "/api/shopping/$id/check", JSONObject().put("checked", checked))

    /** Cooked, on a date, which is what the cook diary is. */
    suspend fun cooked(cfg: Pairing.Config, recipeId: Long, date: String): String =
        send(
            cfg, "POST", "/api/cook-diary",
            JSONObject().put("recipe_id", recipeId).put("date", date).put("kind", "cooked"),
        )

    private suspend fun send(cfg: Pairing.Config, method: String, path: String, body: JSONObject?): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(cfg.serverUrl.trimEnd('/') + path)
                .header("Authorization", "Bearer " + cfg.token)
                .header("Accept", "application/json")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            client.newCall(request).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                    throw ApiError(
                        message?.ifBlank { "Server error " + res.code } ?: ("Server error " + res.code),
                        res.code,
                    )
                }
                text
            }
        }
}
