// The whole demo through the API, against a running Worker: node tests/live/api-flow.mjs [base url]
// It makes real PayPal sandbox invoices. It prints one line per step with what it checked; no keys, no emails.

const BASE = process.argv[2] || 'http://127.0.0.1:8797'
let cookie = ''
// The maintainer's own runs send the jd_maint cookie (JD_MAINT, from .deploy.local.json; never committed).
const maint = process.env.JD_MAINT ? `jd_maint=${process.env.JD_MAINT}` : ''
const cookies = () => [cookie, maint].filter(Boolean).join('; ')
const rows = []

async function call(method, path, body) {
  const t = Date.now()
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookies() ? { cookie: cookies() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  const json = res.headers.get('content-type')?.includes('json') ? await res.json() : null
  return { status: res.status, json, ms: Date.now() - t }
}

function row(step, ok, detail) {
  rows.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`)
  if (!ok) process.exitCode = 1
}

let replayed = 0
const say = async (text) => {
  const out = await call('POST', '/api/agent', { text })
  // A turn answered from the recorded lines (the day's AI budget was used up) is not a live run.
  if (out.json?.replay) replayed++
  return out
}
const jobOf = (state, id) => state.ws.jobs.find((j) => j.id === id)

const made = await call('POST', '/api/workspace', { tz: -new Date().getTimezoneOffset() })
const dave = Object.values(made.json.ws.invoices).find((i) => i.customerId === 'c2')
row('new demo', made.status === 200 && dave?.status === 'SENT', `HTTP ${made.status}; Dave's invoice ${dave?.id} ${dave?.total} ${dave?.status}`)

const maria = await say('Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.')
const p = maria.json.proposal
row('Maria draft', p?.kind === 'invoice' && p.priced.total === '282.42', `HTTP ${maria.status} in ${maria.ms} ms; ${p?.kind} total ${p?.priced?.total}; sources ${p?.priced?.lines.map((l) => l.source).join(', ')}${p?.message ? `; ${p.message}` : ''}`)

const visitEnd = Math.floor(Date.now() / 300_000) * 300_000
const visitStart = visitEnd - 90 * 60_000
const visit = await call('POST', `/api/drafts/${p.draftId}/visit`, { start: new Date(visitStart).toISOString(), end: new Date(visitEnd).toISOString() })
row('Maria visit', visit.status === 200 && Boolean(visit.json.draft?.jobId), `HTTP ${visit.status}; job ${visit.json.draft?.jobId}; ${visit.json.message || ''}`)

const sent = await call('POST', `/api/drafts/${p.draftId}/send`)
const inv = sent.json.state?.ws.invoices[sent.json.invoiceId]
row('Maria send', sent.status === 200 && inv?.status === 'SENT', `HTTP ${sent.status} in ${sent.ms} ms; ${sent.json.invoiceId} ${inv?.status}; QR ${inv?.hasQr}`)
const qr = await fetch(`${BASE}/api/qr/${sent.json.invoiceId}`, { headers: { cookie } })
const png = new Uint8Array(await qr.arrayBuffer())
row('QR image', qr.status === 200 && png[1] === 0x50 && png[2] === 0x4e, `HTTP ${qr.status}; ${qr.headers.get('content-type')}; ${png.length} bytes`)
const again = await call('POST', `/api/drafts/${p.draftId}/send`)
row('repeat tap', again.json.invoiceId === sent.json.invoiceId, `HTTP ${again.status}; same invoice ${again.json.invoiceId === sent.json.invoiceId}`)

const book = await say('Book the bathroom tap for Maria next week.')
const b = book.json.proposal
row('booking', b?.kind === 'booking' && b.deposit === '50.00', `HTTP ${book.status}; ${b?.slot?.label}; deposit ${b?.deposit}; hold ${b?.holdMinutes} min${book.json?.message ? `; ${book.json.message}` : ''}`)
const dep = await call('POST', `/api/drafts/${b.draftId}/send`)
const held = jobOf(dep.json.state, b.jobId)
row('deposit sent', dep.status === 200 && held?.state === 'held', `HTTP ${dep.status}; ${dep.json.invoiceId}; job ${held?.state}`)

const cash = await say('Dave paid cash, 108.')
const c = cash.json.proposal
row('cash proposal', c?.kind === 'cash' && c.amount === '108.00', `HTTP ${cash.status}; ${c?.kind} ${c?.amount} on ${c?.invoiceId}${cash.json?.message ? `; ${cash.json.message}` : ''}`)
const paid = await call('POST', `/api/invoices/${c.invoiceId}/cash`, { amount: c.amount })
const daveAfter = paid.json.state?.ws.invoices[c.invoiceId]
row('cash recorded', paid.status === 200 && daveAfter?.status === 'MARKED_AS_PAID', `HTTP ${paid.status}; ${daveAfter?.status}; due ${daveAfter?.due}; cash ${daveAfter?.cash}`)
const over = await call('POST', `/api/invoices/${c.invoiceId}/cash`, { amount: '5.00' })
row('cash on a paid invoice refused', over.status === 422, `HTTP ${over.status}; ${over.json?.message}`)

const owed = await say('What am I owed?')
row('owed', owed.json.proposal?.kind === 'answer', `HTTP ${owed.status}; "${owed.json.proposal?.text}"${owed.json?.message ? `; ${owed.json.message}` : ''}`)

const bad = await say('Kitchen tap for Maria, two hours, the tap was 89.')
const badLines = bad.json.proposal?.priced?.lines?.map((l) => `${l.name} ${l.quantity}`).join(', ')
// Labour is priced only for the time that was said: any other hours are refused, never priced.
row('no labour line with hours that were not said', bad.json.proposal?.kind === 'invoice' && !bad.json.proposal.priced.lines.some((l) => l.name === 'Labour' && l.quantity !== '2'), `HTTP ${bad.status}; ${badLines}${bad.json?.message ? `; ${bad.json.message}` : ''}`)

const stranger = await say('Gutter clean for Bob, an hour.')
row('unknown customer', stranger.json.proposal?.kind === 'new_customer', `HTTP ${stranger.status}; ${stranger.json.proposal?.kind} ${stranger.json.proposal?.name}${stranger.json?.message ? `; ${stranger.json.message}` : ''}`)

if (!process.argv.includes('--no-wait')) {
  console.log('waiting 125 s for the 2 minute hold to run out')
  await new Promise((r) => setTimeout(r, 125_000))
  const after = await call('GET', '/api/state')
  const freed = jobOf(after.json, b.jobId)
  const priya = jobOf(after.json, 'j5')
  const offer = Object.values(after.json.ws.offers)[0]
  row('hold ran out', freed?.state === 'released' && priya?.state === 'offered', `HTTP ${after.status}; bathroom ${freed?.state}; Priya ${priya?.state} at ${priya?.start}`)
  const depInv = after.json.ws.invoices[dep.json.invoiceId]
  row('deposit cancelled at PayPal', depInv?.status === 'CANCELLED', `${dep.json.invoiceId} ${depInv?.status}`)
  const accept = await call('POST', `/api/offers/${offer.id}/accept`)
  row('offer accepted', accept.status === 200 && jobOf(accept.json.state, 'j5')?.state === 'held', `HTTP ${accept.status}; ${accept.json.invoiceId}`)
}

row('every turn ran live', replayed === 0, `${replayed} turns came from the recorded lines`)

const state = await call('GET', '/api/state')
const calls = state.json.ws.panel.filter((e) => e.kind === 'paypal')
console.log(`\nPayPal calls in the panel: ${calls.length}; codes ${[...new Set(calls.map((e) => e.status))].join(', ')}`)
console.log(`${rows.filter((r) => r.ok).length} of ${rows.length} steps passed`)
