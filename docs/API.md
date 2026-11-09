# Job Done API

The page talks to one Cloudflare Worker. Every call is JSON unless named otherwise. The workspace is chosen by the
cookie `jd_ws`, set by `POST /api/workspace`. Errors answer `{ "error": "<code>", "message": "<plain words>" }`.

## State

`GET /api/state` answers the whole workspace as the page may see it:

```json
{
  "now": 1761660000000,
  "cursor": 42,
  "ws": {
    "id": "...", "tz": -180,
    "settings": { "business": "Elm Street Plumbing", "rateCard": { "currency": "USD", "callout": "45.00", "labourPerHour": "85.00", "billingStepMinutes": 15, "taxPercent": "8", "deposit": "50.00" }, "holdMinutes": 2, "workHours": [8, 17] },
    "customers": [{ "id": "c1", "name": "Maria Lopez", "address": "14 Elm Street", "email": "PayPal sandbox buyer" }],
    "jobs": [{ "id": "j2", "customerId": "c1", "summary": "Kitchen tap", "start": "ISO", "end": "ISO", "state": "booked", "invoiceId": "INV2-...", "depositInvoiceId": "INV2-..." }],
    "invoices": { "INV2-...": { "id": "INV2-...", "customerId": "c1", "jobId": "j2", "kind": "invoice", "total": "282.42", "due": "282.42", "status": "SENT", "sentAt": 0, "reminders": 0, "payerUrl": "https://www.sandbox.paypal.com/...", "cash": false } },
    "holds": [{ "jobId": "j11", "invoiceId": "INV2-...", "start": "ISO", "end": "ISO", "expiresAt": 0, "ended": "paid | released | undefined" }],
    "offers": { "o12": { "id": "o12", "jobId": "j5", "draftId": "d13", "start": "ISO", "end": "ISO", "accepted": false } },
    "drafts": { "d3": { "id": "d3", "kind": "invoice | deposit", "customerId": "c1", "jobId": "j2", "summary": "...", "priced": { "lines": [], "itemTotal": "", "tax": "", "total": "" }, "invoiceId": "set once sent" } },
    "waiting": ["j5"],
    "notices": [{ "n": 40, "at": 0, "text": "Maria paid 282.42.", "kind": "paid", "invoiceId": "INV2-..." }],
    "panel": [{ "n": 41, "at": 0, "kind": "paypal | model | webhook | guard | tool", "method": "POST", "path": "/v2/invoicing/invoices", "status": 201, "ms": 540, "id": "INV2-...", "debugId": "...", "neurons": 26.8, "text": "..." }]
  },
  "budget": { "replay": false, "appLeft": 950, "ipLeft": 380 }
}
```

Job `state` values and their colours: `booked` neutral, `sent` blue, `paid` green, `held` amber, `offered` amber
outline, `released` grey, `late` red (a sent invoice older than 14 days), `waiting` (not on the calendar).

The open page calls `GET /api/state` every 3 seconds. That call also releases holds that ran out.

When the `WORKSPACE` Durable Object binding is enabled, one SQLite backed object serializes reads and writes for each
workspace and keeps its document for 30 days. Existing documents are copied from KV on first access. Without the binding,
the Worker continues to use KV. Workspace saves no longer consume KV writes when the binding is enabled.

## Actions

| Call | Body | Answer |
| --- | --- | --- |
| `POST /api/workspace` | `{ "tz": <minutes east of UTC> }` | the state, and the cookie |
| `POST /api/voice` | raw bytes, `Content-Type: audio/wav`, 16 kHz mono 16 bit, 30 s at most | `{ "text": "..." }`; 413 too long; 415 wrong format; 429 `{ "error": "budget", "replay": true }` |
| `POST /api/agent` | `{ "text": "..." }` | `{ "proposal": {...} or null, "message": "..." or null, "replay": false, "state": {...} }` |
| `POST /api/drafts/:id/send` | none | `{ "invoiceId": "...", "state": {...} }` |
| `POST /api/invoices/:id/cash` | `{ "amount": "120.00" }` | `{ "state": {...} }` |
| `POST /api/invoices/:id/remind` | `{ "text": "..." }` | `{ "state": {...} }` |
| `POST /api/offers/:id/accept` | none | `{ "invoiceId": "...", "state": {...} }` |
| `POST /api/holds/:jobId/expire` | none | `{ "state": {...} }`; demo holds only |
| `POST /api/schedule/move` | `{ "jobId": "j4", "start": "ISO" }` | `{ "ok": true, "text": "...", "state": {...} }` |
| `GET /api/qr/:invoiceId` | none | `image/png`, 300 x 300 |
| `POST /api/settings` | `{ "holdMinutes": 2 or 1440 }` | `{ "state": {...} }` |

Proposal kinds from `POST /api/agent`:

- `invoice`: `{ kind, draftId, customer, summary, priced: { lines: [{ name, quantity, unitAmount, amount, source }], itemTotal, tax, taxPercent, total } }`. One tap: `POST /api/drafts/:draftId/send`.
- `booking`: `{ kind, draftId, jobId, customer, summary, slot: { label, start, end }, deposit, holdMinutes }`. One tap sends the deposit: `POST /api/drafts/:draftId/send`.
- `cash`: `{ kind, invoiceId, customer, amount, due }`. One tap: `POST /api/invoices/:invoiceId/cash`.
- `reminder`: `{ kind, invoiceId, customer, due, tone, text }`. The text can be edited; one tap: `POST /api/invoices/:invoiceId/remind`.
- `answer`: `{ kind, text, invoiceIds }`.
- `new_customer`: `{ kind, name }`.

Each proposal also has a `reason` written by the Worker. A live hold can be run out early with
`POST /api/holds/:jobId/expire` when `holdMinutes` is `2`; the call sets its expiry to now and releases it at once.
It uses one action. A non demo hold answers `409` with `{ "error": "not_demo", "message": "Only demo holds can be run out early." }`.
An unknown or ended hold answers `404`.

## PayPal webhook

`POST /webhooks/paypal` takes PayPal's events. It checks the signature with PayPal before it changes anything.
`GET /health` answers `{ "ok": true, "build": "..." }`.
