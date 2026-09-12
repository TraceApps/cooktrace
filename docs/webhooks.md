# Outgoing Webhooks

Point CookTrace at a URL and it fires a signed HTTP POST the instant
something happens: a recipe is cooked, the shopping list is fully
checked off, or a pantry item runs out of stock. The push counterpart
to the [general public API](public-api.md), for wiring CookTrace into
n8n, Home Assistant, or any other automation without polling. Off by
default.

## Enabling it

```
WEBHOOKS_ENABLED=1
```

Optionally, to allow a webhook target on a private or loopback address
(a same-Docker-network Home Assistant instance, for example):

```
ALLOW_PRIVATE_WEBHOOK_URLS=1
```

## Configuring a webhook

Settings, Webhooks (admin, multi-user mode only, a webhook needs a real
account to own it). Provide a target URL and pick which events to
subscribe to. A secret is generated automatically (or you can supply
your own), shown exactly once, save it, it is needed to verify
signatures on the receiving end and cannot be retrieved again later.

## Events

| Event | Fires when |
|---|---|
| `meal.cooked` | A recipe is logged as cooked, from the cook diary or the "Mark as Cooked" shortcut on a recipe. |
| `shopping_list.completed` | Every unchecked item on the shopping list has been checked off. |
| `pantry.out_of_stock` | A pantry item that was in stock is marked out of stock. |

Not yet built: a `pantry.low_stock` event. Pantry items only carry an
`in_stock` flag and a unit-less quantity today, there is no threshold
concept to detect "running low" against. Revisit if that concept gets
added to the app.

## Payload

Every delivery is a JSON POST with this envelope:

```json
{
  "event": "meal.cooked",
  "timestamp": "2026-09-12T14:30:00.000Z",
  "data": { ... event-specific ... }
}
```

`data` for `meal.cooked` looks like:

```json
{
  "date": "2026-09-12",
  "recipe_id": 42,
  "recipe_name": "Weeknight Chili",
  "kind": "cooked",
  "servings": 4,
  "rating": 5,
  "meal_type": "dinner"
}
```

## Verifying a delivery

Each request carries:

```
X-CookTrace-Signature: sha256=<hex hmac-sha256 of the exact raw request body, using your webhook's secret>
X-CookTrace-Event: meal.cooked
X-CookTrace-Delivery: <a uuid unique to this specific delivery attempt>
```

Recompute the HMAC over the raw body bytes you received (not a
re-serialized copy) and compare it to the signature header. Example in
Node:

```js
import { createHmac, timingSafeEqual } from 'crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signatureHeader.replace('sha256=', '');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
```

## Retries and delivery status

A failed delivery (a network error, a timeout, or a non-2xx response)
is retried up to 3 times total, with a short backoff. There is no
persistent delivery queue: if a receiver is down for longer than a few
seconds, that event is not redelivered later. This is a deliberate
tradeoff for a self-hosted, personal-scale feature rather than a full
delivery queue with hours of retry.

Each webhook's last delivery outcome (delivered or failed, with the
error) is shown in Settings, use the "send test event" button there to
verify a target works without waiting for a real event.
