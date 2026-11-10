# Job Done

Voice invoicing for one person trade businesses. Say what you did. Get paid before you leave the driveway.

Why it matters: 55% of US small businesses that give customers 30 days to pay have overdue invoices, against 26% of
those that ask for payment on the spot (QuickBooks, 2026 Small Business Late Payments Report, published 7 July 2026).
Job Done asks on the spot: the customer pays on the doorstep.

## Judging criteria at a glance

**Technological Implementation.** PayPal Invoicing API: invoices, QR codes, cash payment records, reminders and cancellations, with verified webhooks and a fixed invoice number per draft, so two taps never make two invoices. AI: Whisper on Workers AI turns speech into text, and Granite 4.0 H Micro calls the app's read only tools. Code removes any amount that no tool returned and nobody said.

**Design.** The invoice card reads in three steps: Job, Visit, Payment. Bryntum Calendar shows each job's money state in words and colours. Nothing is sent until you tap Send.

**Potential Impact.** For tradespeople who work alone and write the invoice at night from memory. 55% of US small businesses that give customers 30 days to pay have overdue invoices; of those that ask for payment on the spot, 26% do (QuickBooks, 2026 Small Business Late Payments Report).

**Innovation/Idea.** One flow for the money of a whole job: bill the work, hold the next visit with a deposit, take the deposit off the final bill, and offer an unpaid slot to the next waiting job that fits, with the reason shown.

**Presentation.** The video runs 1 minute 55 seconds. Try it at https://job-done.midknight-labs.workers.dev: say what you did, send the invoice, and watch the job turn green when PayPal reports it paid.

## Judge in 60 seconds

1. Open https://job-done.midknight-labs.workers.dev. A fresh demo business is made for you.
2. Tap the first line under "Try saying" (Maria's kitchen tap). A draft invoice appears; each line says where its
   price came from.
3. Choose the visit or enter a completed visit. Check its start and end times, then tap Confirm visit.
4. Tap Send. A real PayPal sandbox invoice is created and sent, and its QR code opens. Tap "Open the PayPal page",
   log in as the sandbox buyer below, add a tip and pay. About 70 seconds later the job turns green on the Calendar.

What to look at: the "Behind the scenes" panel (every PayPal call with its HTTP code and invoice id), the Calendar
(each job coloured by its money state, and the days PayPal will send its own reminders), and Settings (the rate card).

Sandbox buyer (a PayPal sandbox test account, no real money): `sb-qrlrv53495384@personal.example.com`, password
`GHW>7d)K`.

New since 1 October 2026: all of it. The first commit in this repo is from 22 October 2026.

Hold one button and say what you did: "Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89." Job Done
drafts one invoice priced from your own rate card, and each line says where its price came from. Confirm the visit, then tap Send. This creates and
sends a real PayPal sandbox invoice and shows its QR code, which the customer scans and pays on the doorstep. The job
turns green on the calendar when PayPal says it is paid.

The calendar acts on money. A follow up is offered in the earliest free slot in the period you asked for. Sending its
small deposit invoice holds the slot, and paying it confirms the booking. When that visit is billed, the paid deposit
comes off the final bill. If the deposit is not paid in time, the app cancels that invoice, frees the slot, and offers
it to the first waiting job that fits in length and whose customer is free then. That job's deposit request waits for
your tap. A "Why this slot was offered" panel lists each waiting job it checked and why it was passed over or chosen.

The invoice card reads in three steps: 1 Job, 2 Visit, 3 Payment. Until the visit is confirmed, the card says why Send
waits. A misheard note is easy to fix: "Edit job note" puts the words back in the box. If a request fails or the app asks
back, what you said or typed stays in the box to fix.

This project uses the PayPal sandbox only. No real money moves. Every invoice goes to a sandbox test account or to an
address at example.com, and the code refuses any other address.

## Try it

Hosted demo: https://job-done.midknight-labs.workers.dev

1. Open the page. A fresh demo business is made for you, with four customers and a week of jobs.
2. Hold the button and speak, or type in the box. Try the lines below.
3. Choose the visit or enter a completed visit. Check its start and end times, then tap Confirm visit.
4. Tap Send on the draft. The QR sheet opens. "Open the PayPal page" opens the sandbox invoice.
5. To pay it, log in on that page as the sandbox buyer below.
6. Watch the "Behind the scenes" panel: every PayPal call with its HTTP code and invoice id.

Lines to try:

- Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.
- Book the bathroom tap for Maria next week. (Then wait 2 minutes without paying the deposit.)
- Dave paid cash, 108.
- Remind Sam about his invoice.
- What am I owed?

Sandbox buyer for paying invoices (a PayPal sandbox test account, no real money):

- Email: `sb-qrlrv53495384@personal.example.com`
- Password: `GHW>7d)K`

The demo is free. Every AI call is counted against a daily budget before it runs. When the day's AI budget is used
up, the demo lines are answered from recorded model output, labelled on screen, and the PayPal calls stay live.

## How it works

| Part | What it does |
| --- | --- |
| PayPal Invoicing API | Create, send, QR code, record cash, remind, cancel; tips and part payment on one invoice; PayPal's own reminders, shown on the Calendar and stopped per invoice |
| The rate card that learns | Say "call out is 60 now" and the draft offers a one tap change; code reads the rate from your words, and later lines say "you said 60 on 28 Oct" |
| PayPal Webhooks | Paid and cancelled events, each checked with PayPal's signature verification first |
| Whisper on Workers AI | Speech to text, 30 seconds at most |
| IBM Granite 4.0 H Micro on Workers AI | Calls the app's read only tools: find the customer, price lines from the rate card, find free slots, read open invoices |
| The guard (`src/agent/guard.js`) | Drops any proposal that names an id no tool returned, a part cost that was not said, hours that do not match the time said, or a booking that is not the earliest free slot. Removes any sentence in model text that states an amount no tool returned and nobody said; in a sentence about money a bare "5" counts as an amount. An answer about money is written by code from the open invoices: who owes you, the amount and the link come from one invoice |
| Bryntum Calendar | Day and week views (it opens on the day), each job coloured by its money state; the agent's moves are applied to its event store so they animate |
| Cloudflare Worker, Durable Objects and KV | One Worker serves the pages and API; each workspace lives in a Durable Object. KV keeps the invoice index, expired workspace markers and daily counters. |

The model never sets a price, and a person taps before any invoice or reminder reaches a customer.

## Run it yourself

You need Node 24, a free Cloudflare account and a PayPal developer sandbox app with Invoicing turned on.

Install the dependencies:

```bash
npm install
```

To copy the Bryntum Calendar files again after installing, run:

```bash
npm run vendor
```

Copy the local settings file and put your sandbox app credentials in it:

```bash
cp .dev.vars.example .dev.vars
```

For no AI, run `npm run dev:local`. A stand in answers the demo lines, and the PayPal calls are real sandbox calls.

```bash
npm run dev:local
```

For Workers AI, create the ledger database, put the returned id in `wrangler.jsonc`, and load the schema:

```bash
npx wrangler d1 create hackathon-ledger
```

```bash
npx wrangler d1 execute hackathon-ledger --remote --file=schema/ai_calls.sql
```

Then run the app with `npm run dev`:

```bash
npm run dev
```

To deploy, create the `JOBDONE` KV namespace and put its id in `wrangler.jsonc`:

Run `npm run check:models` to check that the model pages show no retirement notice. Deploy runs this check before it writes files or deploys.

```bash
npx wrangler kv namespace create JOBDONE
```

Create and load the ledger as above. Set the PayPal secrets and `IP_SALT`:

```bash
npx wrangler secret put PAYPAL_CLIENT_ID
```

```bash
npx wrangler secret put PAYPAL_CLIENT_SECRET
```

```bash
npx wrangler secret put PAYPAL_BUYER_EMAIL
```

```bash
npx wrangler secret put IP_SALT
```

Deploy the Worker:

```bash
npx wrangler deploy
```

Register a PayPal webhook for `/webhooks/paypal`, then set its id:

```bash
npx wrangler secret put PAYPAL_WEBHOOK_ID
```

Tests:

```bash
npm test
```

```bash
npm run e2e
```

Bryntum Calendar is commercial software. It is installed from npm as its public trial and copied into `public/vendor/`
at build time; it is never part of this repository. Without it the app uses a plain week grid with the same behaviour.

## Receipts

| What | Number | Where it was measured |
| --- | --- | --- |
| Unit tests | 544 passing; lines 100 percent, branches 97.07 percent | `npx vitest run --coverage`, 24 Oct 2026 |
| Browser tests | 59 passing in one run (happy path with a real sandbox payment, bad paths, error states, calendar, drag and clash, hold release, layout at 3 sizes, customer page, settings, 34 attack tests) | `npm run e2e` against a local Worker, 23 Oct 2026; happy, bad and hold release paths also passed twice on the hosted app |
| Full demo rehearsal, three runs back to back | 155, 158 and 159 s; 17 of 17 steps each; every turn on the live model | `tests/live/api-flow.mjs` on the hosted app, 24 Oct 2026 |
| AI cost of one full demo (Qwen, before 6 Nov 2026) | 12 model calls, about 87 neurons real, 95 counted | Cloudflare analytics and the shared ledger, 24 Oct 2026 |
| AI cost of one agent turn, real (Qwen, before 6 Nov 2026) | 12.68 to 15.55 neurons | Workers AI token counts, 3 recorded turns, 23 Oct 2026 |
| AI cost of one agent turn, charged before it runs (Qwen, before 6 Nov 2026) | 39 to 40 neurons (worst case) | `src/caps.js` |
| AI cost of one step, charged before it runs | 11.592408 neurons (worst case) | Granite constants in `src/caps.js`, 6 Nov 2026 |
| AI cost of one agent turn on Granite, real | 4.58 neurons for "Dave paid cash, 108." (2 calls: 1,145 + 1,174 tokens in, 68 + 31 out) | Workers AI usage, 6 Nov 2026 |
| AI cost of one agent turn on Granite, charged before it runs | 46.37 neurons at most (4 calls: two steps, one JSON retry, one guard retry) | `src/caps.js` |
| Full demo on Granite | 18 of 18 steps, every turn live, 3 runs on a local Worker with the real model and 1 on the hosted app (build efa4829) | `tests/live/api-flow.mjs`, 6 Nov 2026 |
| Whisper cost | 6.82 neurons for 8.8 s of speech (46.63 a minute) | Hosted app, 23 Oct 2026 |
| PayPal create, send, QR and read back in one tap | about 2.3 s (4 calls) | Local Worker against the sandbox, 22 Oct 2026 |
| Paid webhook after a buyer pays | about 70 s, signature SUCCESS | Hosted app, 23 Oct 2026 |

## Licence

MIT. See `LICENSE`.
