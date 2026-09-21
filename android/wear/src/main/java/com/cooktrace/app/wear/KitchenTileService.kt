package com.cooktrace.app.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.LayoutElementBuilders.Column
import androidx.wear.protolayout.LayoutElementBuilders.FONT_WEIGHT_BOLD
import androidx.wear.protolayout.LayoutElementBuilders.FontStyle
import androidx.wear.protolayout.LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER
import androidx.wear.protolayout.LayoutElementBuilders.Spacer
import androidx.wear.protolayout.LayoutElementBuilders.Text
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A tile: what is left to buy, or the timer running, one swipe from the
 * watch face.
 *
 * Drawn from what the app last saved, so it appears instantly and reads
 * correctly in a shop with no signal. Tapping it opens the app, which
 * refreshes and sends anything still waiting.
 */
class KitchenTileService : TileService() {

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        Futures.immediateFuture(ResourceBuilders.Resources.Builder().setVersion(RES_VERSION).build())

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> {
        val paired = Pairing.config(this) != null
        val items = Pairing.list(this)?.let { Kitchen.items(it) }.orEmpty()
        val toBuy = items.count { !it.checked }
        val cook = Pairing.cook(this)
        val timers = Pairing.timers(this).filterNot { it.done(System.currentTimeMillis()) }

        val headline: String
        val detail: String
        when {
            !paired -> {
                headline = "Pair from your phone"
                detail = "Sign in on the phone app"
            }
            timers.isNotEmpty() -> {
                val soonest = timers.minByOrNull { it.endsAt }!!
                headline = Kitchen.clock(soonest.secondsLeft(System.currentTimeMillis()))
                detail = soonest.label.ifBlank { "Timer" } +
                    (if (timers.size > 1) " and ${timers.size - 1} more" else "")
            }
            cook != null -> {
                headline = cook.name.ifBlank { "Cooking" }
                detail = "${cook.steps.size} steps done" +
                    (if (toBuy > 0) " · $toBuy to buy" else "")
            }
            toBuy > 0 -> {
                headline = if (toBuy == 1) "1 to buy" else "$toBuy to buy"
                detail = Kitchen.aisles(items).firstOrNull()?.first ?: "Shopping list"
            }
            else -> {
                headline = "CookTrace"
                detail = "Nothing to buy"
            }
        }

        val openApp = ModifiersBuilders.Modifiers.Builder()
            .setClickable(
                ModifiersBuilders.Clickable.Builder()
                    .setId("open")
                    .setOnClick(
                        ActionBuilders.LaunchAction.Builder()
                            .setAndroidActivity(
                                ActionBuilders.AndroidActivity.Builder()
                                    .setPackageName(packageName)
                                    .setClassName(MainActivity::class.java.name)
                                    .build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()

        val layout = Column.Builder()
            .setModifiers(openApp)
            .setHorizontalAlignment(HORIZONTAL_ALIGN_CENTER)
            .addContent(
                Text.Builder()
                    .setText("CookTrace")
                    .setMaxLines(1)
                    .setFontStyle(FontStyle.Builder().setSize(sp(13f)).setColor(argb(0xFF4DD6E0.toInt())).build())
                    .build(),
            )
            .addContent(Spacer.Builder().setHeight(dp(6f)).build())
            .addContent(
                Text.Builder()
                    .setText(headline)
                    .setMaxLines(2)
                    .setFontStyle(
                        FontStyle.Builder().setSize(sp(20f)).setWeight(FONT_WEIGHT_BOLD)
                            .setColor(argb(0xFFFFFFFF.toInt())).build(),
                    )
                    .build(),
            )
            .addContent(Spacer.Builder().setHeight(dp(4f)).build())
            .addContent(
                Text.Builder()
                    .setText(detail)
                    .setMaxLines(2)
                    .setFontStyle(FontStyle.Builder().setSize(sp(14f)).setColor(argb(0xFFB6BAC6.toInt())).build())
                    .build(),
            )
            .build()

        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RES_VERSION)
            // The app saves the list whenever it opens or something is ticked;
            // a timer counts down, so this keeps the tile honest without
            // waking anything.
            .setFreshnessIntervalMillis(10 * 60 * 1000)
            .setTileTimeline(
                TimelineBuilders.Timeline.Builder()
                    .addTimelineEntry(
                        TimelineBuilders.TimelineEntry.Builder()
                            .setLayout(
                                LayoutElementBuilders.Layout.Builder().setRoot(layout).build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()
        return Futures.immediateFuture(tile)
    }

    companion object {
        private const val RES_VERSION = "1"

        /** Ask the system to redraw the tile after the app saves a new list. */
        fun refresh(ctx: android.content.Context) {
            runCatching { getUpdater(ctx).requestUpdate(KitchenTileService::class.java) }
        }
    }
}
