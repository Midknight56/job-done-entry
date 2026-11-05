// Check three agent proposals with the live model: node tests/live/agent-3x.mjs <base url> [runs=3]

const BASE = process.argv[2] || 'http://127.0.0.1:8797'
const RUNS = Number(process.argv[3] || 3)
const lines = [
  {
    name: 'Maria invoice',
    text: 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.',
    check: (p) => p?.kind === 'invoice' && p.customerId === 'c1' && p.priced?.total === '282.42',
    fields: (p) => `customerId ${p?.customerId}; total ${p?.priced?.total}`,
  },
  {
    name: 'Dave cash',
    text: 'Dave paid cash, 108.',
    check: (p, state) => {
      const invoice = Object.values(state?.ws?.invoices || {}).find((i) => i.customerId === 'c2')
      return p?.kind === 'cash' && p.amount === '108.00' && p.invoiceId === invoice?.id
    },
    fields: (p) => `amount ${p?.amount}; invoiceId ${p?.invoiceId}`,
  },
  {
    name: 'Sam reminder',
    text: 'Remind Sam about his invoice.',
    check: (p, state) => {
      const invoice = Object.values(state?.ws?.invoices || {}).find((i) => i.customerId === 'c3')
      return p?.kind === 'reminder' && p.invoiceId === invoice?.id
    },
    fields: (p) => `invoiceId ${p?.invoiceId}`,
  },
]

let cookie = ''
// The maintainer's own runs send the jd_maint cookie (JD_MAINT, from .deploy.local.json; never committed).
const maint = process.env.JD_MAINT ? `jd_maint=${process.env.JD_MAINT}` : ''
const cookies = () => [cookie, maint].filter(Boolean).join('; ')
let right = 0
let total = 0
let neuronsTotal = 0

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookies() ? { cookie: cookies() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  const json = res.headers.get('content-type')?.includes('json') ? await res.json() : null
  return { status: res.status, json }
}

for (let run = 1; run <= RUNS; run++) {
  const made = await call('POST', '/api/workspace', { tz: -new Date().getTimezoneOffset() })
  if (made.status !== 200) {
    console.log(`FAIL  run ${run} workspace: HTTP ${made.status}`)
    process.exitCode = 1
    continue
  }
  let panelCursor = made.json?.ws?.panel?.length || 0

  for (const line of lines) {
    const answer = await call('POST', '/api/agent', { text: line.text })
    if (answer.json?.replay === true) {
      console.log(`Refusing to run: run ${run} ${line.name} answered with replay true; that is recorded output, not the live model.`)
      process.exit(1)
    }

    const state = answer.json?.state
    const proposal = answer.json?.proposal
    const panel = state?.ws?.panel || []
    const charged = panel.slice(panelCursor).filter((entry) => entry.kind === 'model').reduce((sum, entry) => sum + (Number(entry.neurons) || 0), 0)
    panelCursor = panel.length
    neuronsTotal += charged

    const invoice = Object.values(state?.ws?.invoices || {}).find((i) => i.customerId === 'c3')
    if (line.name === 'Sam reminder' && !invoice) {
      console.log(`not testable here  run ${run} ${line.name}: ${proposal?.kind || 'none'}; neurons ${charged.toFixed(2)}`)
      continue
    }

    const ok = answer.status === 200 && line.check(proposal, state)
    total++
    if (ok) right++
    console.log(`${ok ? 'PASS' : 'FAIL'}  run ${run} ${line.name}: ${proposal?.kind || 'none'}; ${line.fields(proposal)}; neurons ${charged.toFixed(2)}`)
  }
}

console.log(`Total neurons: ${neuronsTotal.toFixed(2)}`)
console.log(`${right} of ${total} right`)
if (right !== total) process.exitCode = 1
