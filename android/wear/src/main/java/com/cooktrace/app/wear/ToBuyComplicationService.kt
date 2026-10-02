package com.cooktrace.app.wear

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/**
 * What is left to buy, on the watch face itself.
 *
 * Reads the list the app last saved, so it costs nothing and is right as of
 * the last thing ticked. Tapping it opens CookTrace.
 */
class ToBuyComplicationService : SuspendingComplicationDataSourceService() {

    companion object {
        /** The count changed: redraw whatever watch face is showing it. */
        fun refresh(ctx: android.content.Context) {
            runCatching {
                androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
                    .create(ctx, ComponentName(ctx, ToBuyComplicationService::class.java))
                    .requestUpdateAll()
            }
        }
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type != ComplicationType.SHORT_TEXT) null
        else shortText("6", "Buy", "6 things left to buy")

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        if (request.complicationType != ComplicationType.SHORT_TEXT) return null
        val items = Pairing.list(this)?.let { Kitchen.items(it) }.orEmpty()
        val toBuy = items.count { !it.checked }
        return when {
            toBuy > 0 -> shortText(toBuy.toString(), "Buy", "$toBuy things left to buy")
            items.isNotEmpty() -> shortText("0", "Buy", "Everything is in the basket")
            else -> shortText("--", "Buy", "Nothing on the list")
        }
    }

    private fun shortText(text: String, title: String, description: String): ComplicationData =
        ShortTextComplicationData.Builder(
            text = PlainComplicationText.Builder(text).build(),
            contentDescription = PlainComplicationText.Builder(description).build(),
        )
            .setTitle(PlainComplicationText.Builder(title).build())
            .setMonochromaticImage(
                MonochromaticImage.Builder(
                    android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_complication),
                ).build(),
            )
            .setTapAction(openApp())
            .build()

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent().apply {
            component = ComponentName(packageName, MainActivity::class.java.name)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        },
        PendingIntent.FLAG_IMMUTABLE,
    )
}
