package com.cooktrace.app.wear

import android.content.Context
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
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

    /** Local mode: the phone couldn't answer (out of reach, or its app closed). What was ticked waits. */
    class PhoneUnavailable(message: String) : IOException(message)

    /** Where Local mode asks the phone (WearPairingPlugin.API_PATH). */
    private const val PHONE_API = "/cooktrace/api"

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        // A watch on a kitchen's wifi is slow, not broken; a phone in another
        // room is gone. Long enough for the first, short enough that the
        // second doesn't leave the screen spinning.
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        // https:// with no cleartext at all: a redirect to http:// fails, as
        // it did before the watch allowed cleartext (TraceApps/nutritrace#194).
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .build()

    // Plain http:// to the confirmed server only, never following a redirect.
    private val plainClient = client.newBuilder()
        .connectionSpecs(listOf(ConnectionSpec.CLEARTEXT))
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /** Everything on the list, the server's own order: aisle, then name. */
    suspend fun list(ctx: Context, cfg: Pairing.Config): String = send(ctx, cfg, "GET", "/api/shopping", null)

    /** One recipe, for the cook the phone handed over. */
    suspend fun recipe(ctx: Context, cfg: Pairing.Config, id: Long): String = send(ctx, cfg, "GET", "/api/recipes/$id", null)

    /** Into the basket, or back out of it. */
    suspend fun check(ctx: Context, cfg: Pairing.Config, id: Long, checked: Boolean): String =
        send(ctx, cfg, "PATCH", "/api/shopping/$id/check", JSONObject().put("checked", checked))

    /** Cooked, on a date, which is what the cook diary is. */
    suspend fun cooked(ctx: Context, cfg: Pairing.Config, recipeId: Long, date: String): String =
        send(
            ctx, cfg, "POST", "/api/cook-diary",
            JSONObject().put("recipe_id", recipeId).put("date", date).put("kind", "cooked"),
        )

    private suspend fun send(ctx: Context, cfg: Pairing.Config, method: String, path: String, body: JSONObject?): String =
        if (cfg.viaPhone) askPhone(ctx, method, path, body) else withContext(Dispatchers.IO) {
            // https:// as saved; plain http:// only to a server on your own
            // network that the phone confirmed (LocalAddress.workerBase).
            // Refused, it fails like no connection.
            // An https:// address goes as saved, as it always has, before the
            // parser below (which refuses international names) sees it.
            val base = (if (cfg.serverUrl.trim().startsWith("https://", ignoreCase = true)) cfg.serverUrl.trim() else null)
                ?: LocalAddress.workerBase(cfg.serverUrl, cfg.httpOk)
                ?: throw IOException("plain HTTP to this server isn't confirmed on the phone")
            val plain = base.startsWith("http:")
            val request = Request.Builder()
                .url(base.trimEnd('/') + path)
                .header("Authorization", "Bearer " + cfg.token)
                .header("Accept", "application/json")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            (if (plain) plainClient else client).newCall(request).execute().use { res ->
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

    /**
     * Local mode: the same request, answered by the phone's app over the Wear
     * connection instead of by a server. A failure here is like no
     * connection: what was ticked waits, and the watch says why.
     */
    private suspend fun askPhone(ctx: Context, method: String, path: String, body: JSONObject?): String {
        val nodes = try {
            Wearable.getNodeClient(ctx).connectedNodes.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw PhoneUnavailable("Phone not nearby")
        }
        val phone = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull() ?: throw PhoneUnavailable("Phone not nearby")
        val request = JSONObject().put("method", method).put("path", path).put("body", body?.toString() ?: JSONObject.NULL)
        val answer = try {
            withTimeout(25_000) {
                Wearable.getMessageClient(ctx).sendRequest(phone.id, PHONE_API, request.toString().toByteArray(Charsets.UTF_8)).await()
            }
        } catch (e: TimeoutCancellationException) {
            throw PhoneUnavailable("Open CookTrace on your phone")
        } catch (e: CancellationException) {
            // The screen closed: nothing to say.
            throw e
        } catch (e: Exception) {
            // No one listening on the phone: its app isn't running.
            throw PhoneUnavailable("Open CookTrace on your phone")
        }
        return readPhoneAnswer(answer)
    }

    /** The phone's reply ({status, body}, WearPairingPlugin.reply): the body, or why not. */
    fun readPhoneAnswer(answer: ByteArray): String {
        val reply = runCatching { JSONObject(String(answer, Charsets.UTF_8)) }.getOrNull()
            ?: throw PhoneUnavailable("Open CookTrace on your phone")
        val status = reply.optInt("status", 500)
        val text = reply.optString("body", "")
        // The app not ready yet, or too slow: what was ticked waits, as offline.
        if (status == 503 || status == 504) throw PhoneUnavailable("Open CookTrace on your phone")
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
            throw ApiError(message?.ifBlank { "Phone error $status" } ?: "Phone error $status", status)
        }
        return text
    }
}
