import { confirmVisit } from './visit.js'
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { openingTime } from '../../public/week.js'

function makeState(overrides = {}) {
  const ws = {
    id: 'battle',
    tz: 0,
    settings: {
      business: 'Elm Street Plumbing',
      rateCard: { currency: 'USD', callout: '45.00', labourPerHour: '85.00', billingStepMinutes: 15, taxPercent: '8', deposit: '50.00' },
      holdMinutes: 2,
      workHours: [8, 17]
    },
    customers: [{ id: 'c1', name: 'Maria Lopez', address: '14 Elm Street', email: 'maria@example.com' }],
    jobs: [],
    invoices: {},
    holds: [],
    offers: {},
    drafts: {},
    waiting: [],
    notices: [],
    panel: []
  }
  Object.assign(ws, overrides.ws || {})
  return { now: Date.now(), ws, budget: { replay: false, appLeft: 950, ipLeft: 380 } }
}

function invoiceProposal(overrides = {}) {
  return {
    kind: 'invoice',
    draftId: 'd1',
    customer: 'Maria Lopez',
    summary: 'Kitchen tap repair',
    priced: { lines: [{ name: 'Tap', quantity: '1', unitAmount: '45.00', amount: '45.00', source: 'rate card' }], itemTotal: '45.00', tax: '0.00', taxPercent: '0', total: '45.00' },
    ...overrides
  }
}

function invoiceState(overrides = {}) {
  return makeState({ ws: {
    invoices: { i1: { id: 'i1', customerId: 'c1', status: 'SENT', total: '45.00', due: '45.00', hasQr: true, payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#i1', sentAt: Date.now() } },
    ...overrides
  } })
}

async function routeState(page, state = makeState()) {
  await page.route('**/api/state**', (route) => route.fulfill({ json: state }))
}

async function routeProposal(page, proposal = invoiceProposal()) {
  await page.route('**/api/agent', (route) => route.fulfill({ json: { proposal, message: null, state: makeState() } }))
}

test.beforeEach(async ({ page }) => {
  await newDemo(page, -new Date().getTimezoneOffset())
})

async function createDraft(page, proposal = invoiceProposal()) {
  await routeState(page)
  await routeProposal(page, proposal)
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair for Maria')
  await page.getByRole('button', { name: 'Send text' }).click()
  return page.locator('#screen article.card')
}

test('model markup in invoice text stays inert', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>'
  const card = await createDraft(page, invoiceProposal({ summary: payload, customer: payload }))
  await expect(card.locator('img, script')).toHaveCount(0)
  await expect(card).toContainText(payload)
  expect(errors).toEqual([])
})

test('a hostile customer name stays text in a cash proposal', async ({ page }) => {
  await routeState(page)
  await routeProposal(page, { kind: 'cash', amount: '12.00', customer: '<svg onload=alert(1)>' })
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Cash')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.locator('#screen svg')).toHaveCount(0)
  await expect(page.locator('#screen')).toContainText('<svg onload=alert(1)>')
})

test('model HTML in reminder text stays text', async ({ page }) => {
  await routeState(page)
  await routeProposal(page, { kind: 'reminder', customer: 'Maria', tone: 'kind', text: '<img src=x onerror=alert(1)>' })
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Remind Maria')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.locator('#screen img')).toHaveCount(0)
  await expect(page.locator('.remind-text')).toHaveValue('<img src=x onerror=alert(1)>')
})

test('notice markup stays inert', async ({ page }) => {
  await routeState(page, makeState({ ws: { notices: [{ text: '<img src=x onerror=alert(1)>', n: 1 }] } }))
  await page.goto('/?calendar=fallback')
  await expect(page.locator('#screen img')).toHaveCount(0)
  await expect(page.locator('.notice')).toContainText('<img src=x onerror=alert(1)>')
})

test('very long words fit a narrow phone without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  const long = 'x'.repeat(700)
  await createDraft(page, invoiceProposal({ summary: long, customer: long }))
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
})

test('right to left marks and emoji remain readable text without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  const text = '\u202eCustomer 🧰🧑🏽‍🔧 ' + '🧱'.repeat(80)
  const card = await createDraft(page, invoiceProposal({ summary: text }))
  await expect(card).toContainText(text)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
})

for (const payerUrl of ['javascript:alert(1)', 'https://evil.example/pay', 'https://sandbox.paypal.com/pay']) {
  test(`unapproved payer URL ${payerUrl} is not rendered as a link`, async ({ page }) => {
    const state = invoiceState({ invoices: { i1: { ...invoiceState().ws.invoices.i1, payerUrl } } })
    await routeState(page, state)
    await page.goto('/?calendar=fallback')
    await page.locator('.notice').count()
    await page.evaluate(async () => {
      const { openInvoiceSheet } = await import('/sheet.js')
      const response = await fetch('/api/state')
      window.testState = await response.json()
      await openInvoiceSheet('i1', window.testState, async () => new Blob())
    })
    await expect(page.locator('#sheet')).toBeVisible()
    await expect(page.locator('#sheet a[href="' + payerUrl + '"]')).toHaveCount(0)
  })
}

test('approved PayPal link and customer view use trusted origins', async ({ page }) => {
  await routeState(page, invoiceState())
  await page.goto('/?calendar=fallback')
  await page.evaluate(async () => {
    const { openInvoiceSheet } = await import('/sheet.js')
    const state = await (await fetch('/api/state')).json()
    await openInvoiceSheet('i1', state, async () => new Blob())
  })
  await expect(page.locator('#sheet a')).toHaveCount(2)
  expect(await page.locator('#sheet a').first().getAttribute('href')).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//)
  expect(new URL(await page.locator('#sheet a').nth(1).getAttribute('href'), page.url()).origin).toBe(new URL(page.url()).origin)
})

/** Two clicks in the same moment, the way a fast double tap reaches the page. @param {import('@playwright/test').Locator} button */
async function doubleTap(button) {
  await button.evaluate((element) => { element.click(); element.click() })
}

test('two quick taps on Send make one request', async ({ page }) => {
  let sends = 0
  await createDraft(page)
  await page.route('**/api/drafts/d1/send', async (route) => {
    sends += 1
    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({ json: { state: makeState(), invoiceId: 'i1' } })
  })
  const send = page.getByRole('button', { name: 'Send 45.00' })
  await confirmVisit(page, send)
  await doubleTap(send)
  await page.waitForTimeout(600)
  await expect.poll(() => sends).toBe(1)
})

test('a covered bill requires confirmation and opens a receipt with its surplus', async ({ page }) => {
  const settlement = { id: 's1', customerId: 'c1', jobId: 'j1', summary: 'Call out', depositInvoiceId: 'DEP', jobTotal: '48.60', depositTotal: '50.00', depositRetained: '50.00', depositCredit: '48.60', depositSurplus: '1.40', due: '0.00', resolution: 'required' }
  const completeState = makeState({ ws: { settlements: { s1: settlement }, jobs: [{ id: 'j1', customerId: 'c1', state: 'paid', settlementId: 's1' }], notices: [{ n: 1, text: 'Job complete. Surplus 1.40 needs resolution.', settlementId: 's1' }] } })
  const proposal = invoiceProposal({ jobId: 'j1', priced: { lines: [], itemTotal: '45.00', tax: '3.60', taxPercent: '8', total: '0.00', jobTotal: '48.60', depositTotal: '50.00', depositRetained: '50.00', depositCredit: '48.60', depositSurplus: '1.40' } })
  const card = await createDraft(page, proposal)
  let completions = 0
  await page.route('**/api/drafts/d1/complete', async route => {
    completions++
    expect(route.request().postDataJSON()).toEqual({ confirmed: true })
    await routeState(page, completeState)
    await route.fulfill({ json: { settlement, state: completeState } })
  })
  await expect(card.getByText('Paid deposit', { exact: true }).locator('..')).toContainText('50.00')
  await expect(card.getByText('Applied credit', { exact: true }).locator('..')).toContainText('48.60')
  await expect(card.getByText('Surplus to resolve', { exact: true }).locator('..')).toContainText('1.40')
  const complete = card.getByRole('button', { name: 'Complete job', exact: true })
  await expect(complete).toBeDisabled()
  await card.getByRole('checkbox', { name: 'I confirm this job is complete.' }).check()
  await expect(complete).toBeEnabled()
  await doubleTap(complete)
  await expect(page.locator('#sheet')).toBeVisible()
  await expect(page.locator('#sheet')).toContainText('Job complete')
  await expect(page.locator('#sheet')).toContainText('Surplus to resolve 1.40')
  await expect(page.locator('#sheet a, #sheet img')).toHaveCount(0)
  expect(completions).toBe(1)
  await page.locator('#sheet').getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('.notice').click()
  await expect(page.locator('#sheet')).toContainText('Deposit invoice DEP')
})

test('two quick taps on Record cash make one request', async ({ page }) => {
  let count = 0
  const card = await createDraft(page, { kind: 'cash', amount: '12.00', customer: 'Maria', invoiceId: 'i1' })
  await page.route('**/api/invoices/i1/cash', async (route) => {
    count += 1
    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({ json: { state: makeState() } })
  })
  const button = card.getByRole('button', { name: 'Record cash' })
  await doubleTap(button)
  await page.waitForTimeout(600)
  await expect.poll(() => count).toBe(1)
})

test('two quick taps on Accept offer make one request', async ({ page }) => {
  let count = 0
  const state = makeState({ ws: { offers: { o1: { id: 'o1', jobId: 'j1', start: new Date().toISOString(), accepted: false } }, jobs: [{ id: 'j1', customerId: 'c1' }] } })
  await routeState(page, state)
  await page.route('**/api/offers/o1/accept', async (route) => {
    count += 1
    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({ json: { state, invoiceId: 'i1' } })
  })
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const button = page.getByRole('button', { name: /Send deposit/ })
  await doubleTap(button)
  await page.waitForTimeout(600)
  await expect.poll(() => count).toBe(1)
})

test('two quick taps on Run out the hold now make one request', async ({ page }) => {
  let count = 0
  const state = makeState({ ws: { holds: [{ jobId: 'j1', expiresAt: Date.now() + 60_000 }], jobs: [{ id: 'j1', customerId: 'c1' }] } })
  await routeState(page, state)
  await page.route('**/api/holds/j1/expire', async (route) => {
    count += 1
    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({ json: { state } })
  })
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const button = page.getByRole('button', { name: 'Run out the hold now' })
  await doubleTap(button)
  await page.waitForTimeout(600)
  await expect.poll(() => count).toBe(1)
})

for (const [name, response] of [
  ['server error', { status: 500, json: true, body: 'Service unavailable.', shown: 'Service unavailable.' }],
  ['budget limit', { status: 429, json: true, body: 'That is enough for today. Try again tomorrow.', shown: 'That is enough for today. Try again tomorrow.' }],
  ['non JSON answer', { status: 200, json: false, body: '<html>bad gateway</html>', shown: 'Something went wrong. Try again.' }],
]) {
  test(`${name} shows a plain message and keeps the page usable`, async ({ page }) => {
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await routeState(page)
    await page.route('**/api/agent', (route) => route.fulfill({
      status: response.status,
      contentType: response.json ? 'application/json' : 'text/html',
      body: response.json ? JSON.stringify({ message: response.body }) : response.body,
    }))
    await page.goto('/?calendar=fallback')
    await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair')
    await page.getByRole('button', { name: 'Send text' }).click()
    await expect(page.locator('#screen')).toBeVisible()
    await expect(page.locator('#say')).toBeVisible()
    await expect(page.locator('.quiet')).toContainText(response.shown)
    expect(errors).toEqual([])
  })
}

test('PayPal 502 leaves the draft visible and usable', async ({ page }) => {
  const card = await createDraft(page)
  await page.route('**/api/drafts/d1/send', (route) => route.fulfill({ status: 502, json: { message: 'PayPal is unavailable.' } }))
  await confirmVisit(page, card.getByRole('button', { name: 'Send 45.00' }))
  await card.getByRole('button', { name: 'Send 45.00' }).click()
  await expect(page.getByText('PayPal is unavailable.')).toBeVisible()
  await expect(card).toBeVisible()
})

test('a failed network request shows a plain message and keeps typing available', async ({ page }) => {
  await routeState(page)
  await page.route('**/api/agent', (route) => route.abort())
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByText('No connection. Try again.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Describe the job' })).toBeVisible()
})

test('a success answer without workspace state shows an error instead of crashing', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await routeState(page)
  await page.route('**/api/agent', (route) => route.fulfill({ json: { proposal: null, message: 'Done' } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.locator('.quiet')).toContainText('Something went wrong. Try again.')
  expect(errors).toEqual([])
})

test('an answer missing proposal fields stays usable', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await routeState(page)
  await page.route('**/api/agent', (route) => route.fulfill({ json: { proposal: { kind: 'invoice' }, message: null, state: makeState() } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.locator('#say')).toBeVisible()
  expect(errors).toEqual([])
})

test('an answer with no proposal field shows a plain error', async ({ page }) => {
  await routeState(page)
  await page.route('**/api/agent', (route) => route.fulfill({ json: { message: 'Done', state: makeState() } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.locator('.quiet')).toContainText('Something went wrong. Try again.')
  await expect(page.getByRole('textbox', { name: 'Describe the job' })).toBeVisible()
})

test('closing an invoice sheet with Escape restores focus to its opener', async ({ page }) => {
  await routeState(page, invoiceState())
  await page.goto('/?calendar=fallback')
  const opener = page.locator('#screen').evaluateHandle((screen) => {
    const button = document.createElement('button')
    button.textContent = 'Open invoice'
    screen.append(button)
    return button
  })
  await (await opener).asElement().focus()
  await page.evaluate(async () => {
    const { openInvoiceSheet } = await import('/sheet.js')
    const state = await (await fetch('/api/state')).json()
    await openInvoiceSheet('i1', state, async () => new Blob())
  })
  await page.keyboard.press('Escape')
  await expect(page.locator('#sheet')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open invoice' })).toBeFocused()
})

test('closing and reopening the invoice sheet redraws its QR state', async ({ page }) => {
  await routeState(page, invoiceState())
  await page.goto('/?calendar=fallback')
  await page.evaluate(async () => {
    const { openInvoiceSheet } = await import('/sheet.js')
    const state = await (await fetch('/api/state')).json()
    await openInvoiceSheet('i1', state, async () => new Blob())
  })
  await page.locator('#sheet').getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('#sheet')).toBeHidden()
  await page.evaluate(async () => {
    const { openInvoiceSheet } = await import('/sheet.js')
    const state = await (await fetch('/api/state')).json()
    await openInvoiceSheet('i1', state, async () => new Blob())
  })
  await expect(page.locator('#sheet')).toBeVisible()
  await expect(page.locator('#sheet')).toContainText('Waiting for payment')
})

test('a paid invoice refresh removes payment links from the open sheet', async ({ page }) => {
  const state = invoiceState()
  await routeState(page, state)
  await page.goto('/?calendar=fallback')
  await page.evaluate(async () => {
    const { openInvoiceSheet, updateInvoiceSheet } = await import('/sheet.js')
    const state = await (await fetch('/api/state')).json()
    await openInvoiceSheet('i1', state, async () => new Blob())
    state.ws.invoices.i1.status = 'PAID'
    updateInvoiceSheet(state)
  })
  await expect(page.locator('#sheet')).toContainText('Paid')
  await expect(page.locator('#sheet a')).toHaveCount(0)
})

test('a cancelled invoice sheet shows Cancelled with no payment links when refreshed', async ({ page }) => {
  await routeState(page, invoiceState())
  await page.goto('/?calendar=fallback')
  await page.evaluate(async () => {
    const { openInvoiceSheet, updateInvoiceSheet } = await import('/sheet.js')
    const state = await (await fetch('/api/state')).json()
    await openInvoiceSheet('i1', state, async () => new Blob())
    state.ws.invoices.i1.status = 'CANCELLED'
    updateInvoiceSheet(state)
  })
  await expect(page.locator('#sheet')).toBeVisible()
  await expect(page.locator('#sheet .pay-status')).toContainText('Invoice cancelled')
  await expect(page.locator('#sheet .qr-card')).toHaveCount(0)
  await expect(page.locator('#sheet .pay-links')).toHaveCount(0)
})

test('a missing workspace closes an open invoice sheet', async ({ page }) => {
  await routeState(page, invoiceState())
  await page.goto('/?calendar=fallback')
  await page.evaluate(async () => {
    const { openInvoiceSheet, updateInvoiceSheet } = await import('/sheet.js')
    const state = await (await fetch('/api/state')).json()
    await openInvoiceSheet('i1', state, async () => new Blob())
    updateInvoiceSheet(null)
  })
  await expect(page.locator('#sheet')).toBeHidden()
})

test('a denied microphone asks the person to type', async ({ page, context }) => {
  await routeState(page)
  await context.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('button', { name: 'Hold to talk' }).hover()
  await page.mouse.down()
  await expect(page.getByRole('textbox', { name: 'Describe the job' })).toHaveAttribute('placeholder', 'No microphone. Type it instead.')
  await page.mouse.up()
})

test('recording works when MediaRecorder is unavailable', async ({ page, context }) => {
  await routeState(page)
  await context.addInitScript(() => {
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
    class AudioContextMock {
      sampleRate = 16000
      destination = {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null } }
      createGain() { return { gain: {}, connect() {}, disconnect() {} } }
      close() { return Promise.resolve() }
    }
    window.AudioContext = AudioContextMock
  })
  await page.goto('/?calendar=fallback')
  const button = page.getByRole('button', { name: 'Hold to talk' })
  await button.hover()
  await page.mouse.down()
  await expect(button).toHaveClass(/recording/)
  await expect(page.getByRole('textbox', { name: 'Describe the job' })).toBeVisible()
  await page.mouse.up()
})

test('a recording stopped at once makes no voice request', async ({ page, context }) => {
  let voices = 0
  await routeState(page)
  await page.route('**/api/voice', (route) => { voices += 1; return route.fulfill({ json: { text: 'empty' } }) })
  await context.addInitScript(() => {
    const track = { stop() {} }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } })
    class AudioContextMock {
      sampleRate = 16000
      destination = {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null } }
      createGain() { return { gain: {}, connect() {}, disconnect() {} } }
      close() { return Promise.resolve() }
    }
    window.AudioContext = AudioContextMock
  })
  await page.goto('/?calendar=fallback')
  await page.getByRole('button', { name: 'Hold to talk' }).hover()
  await page.mouse.down()
  await page.waitForTimeout(20)
  await page.mouse.up()
  await page.waitForTimeout(30)
  expect(voices).toBe(0)
})

test('an empty calendar renders without errors', async ({ page }) => {
  await routeState(page)
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.locator('.cal-grid')).toBeVisible()
  await expect(page.locator('.job-block')).toHaveCount(0)
})

test('forty jobs on one day render without horizontal overflow', async ({ page }) => {
  const now = new Date(openingTime(Date.now(), 0))
  const weekday = (now.getUTCDay() + 6) % 7
  const selected = weekday < 5 ? weekday : 0
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - weekday + selected, 9))
  const jobs = Array.from({ length: 40 }, (_, index) => ({ id: `j${index}`, customerId: 'c1', summary: `Job ${index}`, start: start.toISOString(), end: new Date(start.getTime() + 30 * 60_000).toISOString(), state: 'booked' }))
  await page.setViewportSize({ width: 360, height: 800 })
  await routeState(page, makeState({ ws: { jobs } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.locator('.job-block')).toHaveCount(40)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
})

test('a job without a start time is ignored by the calendar', async ({ page }) => {
  await routeState(page, makeState({ ws: { jobs: [{ id: 'j1', customerId: 'c1', summary: 'Unscheduled', state: 'waiting', start: null }] } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.locator('.job-block')).toHaveCount(0)
})

test('an expired hold shows zero time and cannot be run out again', async ({ page }) => {
  const now = new Date(openingTime(Date.now(), 0))
  const weekday = (now.getUTCDay() + 6) % 7
  const selected = weekday < 5 ? weekday : 0
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - weekday + selected, 9))
  const job = { id: 'j1', customerId: 'c1', summary: 'Held work', start: start.toISOString(), end: new Date(start.getTime() + 60_000).toISOString(), state: 'booked' }
  await routeState(page, makeState({ ws: { holds: [{ jobId: 'j1', expiresAt: Date.now() - 1000 }], jobs: [job] } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.getByRole('button', { name: 'Run out the hold now' })).toHaveCount(0)
  await expect(page.locator('.job-block small')).toHaveText('Held, deposit 50.00, 0:00')
})

test('a partial refund is clear in the sheet and customer view', async ({ page }) => {
  await routeState(page, invoiceState({ invoices: { i1: { id: 'i1', customerId: 'c1', status: 'PARTIALLY_REFUNDED', total: '50.00', due: '0.00', paid: '50.00', refunded: '10.00', hasQr: true, payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#i1' } } }))
  await page.goto('/?calendar=fallback')
  await page.evaluate(async () => {
    const { openInvoiceSheet } = await import('/sheet.js')
    await openInvoiceSheet('i1', await (await fetch('/api/state')).json(), async () => { throw new Error('No QR is needed') })
  })
  await expect(page.locator('#sheet .pay-status')).toHaveText('Part refunded, 10.00 returned')
  await expect(page.locator('#sheet .qr, #sheet .pay-link')).toHaveCount(0)
  await page.goto('/customer.html?inv=i1')
  await expect(page.locator('#status')).toHaveText('Part refunded, 10.00 returned')
  await expect(page.locator('#payment-help')).toBeHidden()
  await expect(page.locator('#qr')).toBeHidden()
})
