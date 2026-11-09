# Review package

Each claim in the Devpost text (`DEVPOST.md`) and the film, with the code that makes it true, the test that
proves it, and where the film shows it. Test names are quoted exactly; run them with `npm test` (unit) or
`npx playwright test <file>` against a local worker (`npm run dev:local`) or the hosted app.

Source revision: the live build `2a4e457`. Results below are from 9 Nov 2026.

## Results

| Check | Result |
| --- | --- |
| Unit tests (`npx vitest run`) | 887 passed |
| Type check (`npx tsc`) | 0 errors |
| Browser tests (`npx playwright test`, local worker) | 113 passed, 0 failed, 7 skipped |
| Full demo on the hosted app (`tests/live/api-flow.mjs`) | 18 of 18 steps, every AI turn live |
| Three agent turns, three times, on the hosted app (`tests/live/agent-3x.mjs`) | 9 of 9 |

## The connected money story

| Claim | Code | Test | Film |
| --- | --- | --- | --- |
| A spoken note becomes one draft priced from the rate card, and each line says where its price came from | `checkFinal()` in `src/agent/guard.js` (prices from the rate card, a part cost must have been said, labour hours must match the time said) | `tests/unit/guard.test.js`, `tests/e2e/happy.spec.js` | 0:04 |
| Send waits until the visit is confirmed, and the card says why | `confirmInvoiceVisit()` in `src/flows/send.js`; the visit step in `renderProposal()`, `public/cards.js` | "an existing visit: three steps, a visit summary, and Send waits with a reason" (`tests/e2e/invoice-steps.spec.js`) | 0:11 |
| One tap: PayPal creates and sends the invoice, the app checks PayPal's total, then shows the QR | `sendDraft()` in `src/flows/send.js` | "creates, reads the total, sends, gets the QR and reads the payer link in that order" and "does not send when PayPal total differs from the draft and keeps the invoice id" (`tests/unit/send.test.js`) | 0:18 |
| Two taps never make two invoices | `invoiceNumber()` in `src/flows/send.js` | "each draft has a fixed invoice number; a duplicate number finds the first invoice and makes no second one" (`tests/unit/send.test.js`) | |
| Paid is set only by a verified webhook or a status read from PayPal; the film says which | `handleWebhook()` in `src/paypal/webhooks.js`, `applyStatus()` (`paidBy`) in `src/state/money.js` | "a verify result other than SUCCESS gives 400 and no change" (`tests/unit/webhook.test.js`), "rejects a bad signature without changing money" (`tests/unit/battle-d.test.js`) | 0:34 |
| A follow up takes the earliest free slot; it is an offer until the deposit is paid | `findSlots()` in `src/state/schedule.js`; the booking block in `src/agent/loop.js`; the booking check in `checkFinal()` | "takes the first free slot even when the model called find_slots and chose a later one" (`tests/unit/loop.test.js`), "drops a booking that is not the first free slot" (`tests/unit/guard.test.js`) | 0:42 |
| Paying the deposit confirms the booking | `applyStatus()` in `src/state/money.js` | "a paid deposit (webhook) ends the hold" (`tests/unit/holds.test.js`), "a booking deposit marks the job booked and records the deposit" (`tests/unit/booking-lifecycle.test.js`) | 0:52 |
| The paid deposit comes off the final bill; the card shows job price, paid deposit and balance | `balancePrice()` in `src/flows/send.js` | "R6 item 3 shows the full deposit, applied credit and unresolved surplus" (`tests/unit/r6-settlement.test.js`), "a covered bill requires confirmation and opens a receipt with its surplus" (`tests/e2e/battle-f.spec.js`) | 0:55 |
| An unpaid hold runs out on the server, even with the page closed; the deposit invoice is cancelled before the slot is freed | `releaseExpired()` and `release()` in `src/state/holds.js`; the alarm in `src/state/workspace-do.js` | "releases an unpaid hold and drafts a replacement with no state poll" and "lets payment win at expiry without cancelling the invoice" (`tests/unit/workspace-do.test.js`) | 1:02 and 1:07 |
| The slot goes to the first waiting job that fits in length and whose customer is free then; a panel says why | `offerNext()`, `startRecovery()`, `recoveryStage()` in `src/state/holds.js`; `freeFor()` in `src/state/waiting.js`; `renderRecovery()` in `public/app.js` | "keeps every job considered, why each was skipped, and the one chosen, with no invoice sent", "names its stage from state: offered, deposit requested, booking confirmed" (`tests/unit/holds.test.js`), "a freed slot explains every waiting job it considered" (`tests/e2e/recovery.spec.js`) | 1:14 |
| The new deposit request waits for your tap | `/api/offers/<id>/accept` in `src/worker.js` | "accepting the offer sends Priya her deposit and starts a new hold" (`tests/unit/holds.test.js`) | 1:22 |

## What the model may say

| Claim | Code | Test | Film |
| --- | --- | --- | --- |
| Every customer, invoice and slot id must come from a tool result in the same turn | `checkFinal()` in `src/agent/guard.js` | `tests/unit/guard.test.js` | |
| In every text the model writes, a sentence with an amount that no tool returned and nobody said is removed; in a sentence about money a bare "5" or "five" is an amount, and a number before "days", "hours" or "invoices" is a count | `scrubText()` and `figuresIn()` in `src/agent/guard.js` | "removes a sentence holding an amount not in the tool results", "removes an unsupported figure from a booking summary", "removes unsupported figures from a new customer name", "treats small amounts with a currency as money", "treats a small whole number in a money sentence as money" (`tests/unit/guard.test.js`) | 0:04, "The AI picks the lines. Code sets every price." |
| An answer about money is written by code from the open invoice rows: who owes you, the amount, how late, and the link all come from one invoice; the model only picks which invoices | `owedText()` and the answer case of `build()` in `src/agent/loop.js` | "a money answer is built from the invoice rows, not the model text: a reversed direction", "a money answer is built from the invoice rows, not the model text: a figure from another tool linked to the wrong invoice", "a money answer is built from the invoice rows, not the model text: a small whole number in a money sentence", "a money answer about one customer lists only the rows the model chose, each with its own link" (`tests/unit/loop.test.js`) | 1:43 |

## Fixing a misheard note, and reminders

| Claim | Code | Test | Film |
| --- | --- | --- | --- |
| "Edit job note" puts the words back; a failed request or a question back keeps what you typed or said, in the box to fix | `submitText()` and `helpers.editNote` in `public/app.js`; the button in `public/cards.js` | "Edit job note puts the note back without any request, and a resend gives a fresh draft", "a lost connection puts the typed note back in the box", "a server error puts the typed note back in the box", "a question back keeps the words in the box to fix and send again" (`tests/e2e/errors.spec.js`) | |
| "Copy message" copies your own words; "Send PayPal reminder" sends PayPal's standard reminder | `remindInvoice()` in `src/paypal/invoices.js`; the reminder card in `public/cards.js` | "copying a reminder message uses the clipboard and sends no request" (`tests/e2e/remind-text.spec.js`), "explains standard reminder delivery and the separate draft" (`tests/unit/loop.test.js`) | 1:34 |
| The Owed tab lists late invoices first and opens one from its amount | `renderOwed()` in `public/app.js` | "late invoices come first in Owed, and an amount opens its invoice" (`tests/e2e/screens-order.spec.js`) | 1:27 |
| Bryntum Calendar opens on the day view in the phone; its mode buttons switch to the week | `public/calendar.js` (`mode`) | "phone calendar opens a day, shows tap details and a held deposit" (`tests/e2e/calendar-phone.spec.js`) | The film page uses `?video=1`, which opens the week view to fill the frame |

## Time jumps in the film

Each jump is marked on screen. Times are from the film linked on the Devpost page (1:54).

| Film | What was cut | Said on screen |
| --- | --- | --- |
| 0:34 | The wait between the customer's payment and Paid on the phone | "Seen by a status check. Real wait 27 s, cut." |
| 0:55 | The visit is billed before its day | "Billed before the visit day for this demo" |
| 1:02 | The two minute deposit hold running out | "Hold set to 2 minutes for this demo." and "Real wait 1 min 58 s, cut" |

