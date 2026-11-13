package com.cooktrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Local mode: what the watch makes of the phone's reply. */
class PhoneAnswerTest {
    private fun reply(status: Int, body: String) =
        org.json.JSONObject().put("status", status).put("body", body).toString().toByteArray()

    @Test fun anAnswerIsTheBody() {
        assertEquals("[]", CookApi.readPhoneAnswer(reply(200, "[]")))
    }

    @Test fun anAppNotReadyOrTooSlowWaitsLikeNoConnection() {
        for (status in listOf(503, 504)) {
            try { CookApi.readPhoneAnswer(reply(status, "{}")); fail() } catch (e: CookApi.PhoneUnavailable) {
                assertEquals("Open CookTrace on your phone", e.message)
            }
        }
        try { CookApi.readPhoneAnswer("not json".toByteArray()); fail() } catch (e: CookApi.PhoneUnavailable) { }
    }

    @Test fun aRefusalSaysWhyAndIsNotSignedOut() {
        try { CookApi.readPhoneAnswer(reply(409, "{\"error\":\"The phone is connected to a server now.\"}")); fail() } catch (e: CookApi.ApiError) {
            assertEquals(409, e.code)
            assertEquals("The phone is connected to a server now.", e.message)
            assertTrue(e.code != 401 && e.code != 403)
        }
    }

    @Test fun theAddressMatchesThePhones() {
        assertEquals("phone:", Pairing.PHONE)
        assertTrue(Pairing.Config(Pairing.PHONE, "local").viaPhone)
        assertTrue(!Pairing.Config("https://cook.example", "t").viaPhone)
    }
}
