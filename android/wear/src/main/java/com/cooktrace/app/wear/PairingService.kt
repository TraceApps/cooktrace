package com.cooktrace.app.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/**
 * The phone's half of pairing arriving on the watch.
 *
 * The phone app writes /cooktrace/pairing into the Data Layer with the server
 * address and a token for the signed-in account, and deletes it on sign-out.
 * Nothing is typed on the watch.
 */
class PairingService : WearableListenerService() {

    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            val path = event.dataItem.uri.path ?: continue
            if (path.startsWith(COOK_PATH)) {
                // The end of a cook arrives as a dated record saying so,
                // never as a deletion, so a deletion here is the Data Layer
                // tidying up after a device rather than anyone finishing
                // anything. Acting on it would close a cook the other device
                // is still in.
                if (event.type != DataEvent.TYPE_DELETED) {
                    Pairing.putCook(this, DataMapItem.fromDataItem(event.dataItem).dataMap)
                }
                continue
            }
            if (!path.startsWith(PATH)) continue
            if (event.type == DataEvent.TYPE_DELETED) {
                Pairing.clear(this)
                continue
            }
            val map = DataMapItem.fromDataItem(event.dataItem).dataMap
            val url = map.getString("serverUrl").orEmpty()
            val token = map.getString("token").orEmpty()
            if (url.isNotBlank() && token.isNotBlank()) Pairing.save(this, url, token)
            else Pairing.clear(this)
        }
    }

    /** A nudge from the phone: the account signed out, forget everything. */
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path == "$PATH/signout") Pairing.clear(this)
    }

    companion object {
        const val PATH = "/cooktrace/pairing"
        /** The recipe the phone put you in, and what has been ticked off it. */
        const val COOK_PATH = "/cooktrace/cook"
    }
}
