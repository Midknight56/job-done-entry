import { confirmVisit } from './visit.js'
import { test, expect } from '@playwright/test'

function makeState(replay = false) {
  return {
    now: 1761660000000,
    cursor: 1,
    ws: {
      id: 'test',
      tz: -180,
      settings: {
        business: 'Elm Street Plumbing',
        rateCard: {
          currency: 'USD',
          callout: '45.00',
          labourPerHour: '85.00',
          billingStepMinutes: 15,
          taxPercent: '8',
          deposit: '50.00'
        },
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
    },
    budget: { replay, appLeft: 950, ipLeft: 380 }
  }
}

function invoiceProposal() {
  return {
    kind: 'invoice',
    draftId: 'd1',
    customer: 'Maria Lopez',
    summary: 'Kitchen tap repair',
    priced: {
      lines: [
        { name: 'Callout', quantity: '1', unitAmount: '45.00', amount: '45.00', source: 'rate card' },
        { name: 'Labour', quantity: '1.5', unitAmount: '85.00', amount: '127.50', source: 'rate card' },
        { name: 'Kitchen tap', quantity: '1', unitAmount: '89.00', amount: '89.00', source: 'customer supplied' }
      ],
      itemTotal: '261.50',
      tax: '20.92',
      taxPercent: '8',
      total: '282.42'
    }
  }
}

async function routeState(page, state = makeState()) {
  await page.route('**/api/state**', (route) => route.fulfill({ json: state }))
}

test('a PayPal error leaves the invoice draft on screen', async ({ page }) => {
  await routeState(page)
  await page.route('**/api/agent', (route) => route.fulfill({
    json: { proposal: invoiceProposal(), message: null, state: makeState() }
  }))
  await page.route('**/api/drafts/d1/send', (route) => route.fulfill({
    status: 502,
    json: { error: 'paypal', message: 'PayPal answered 500 INTERNAL_SERVER_ERROR, debug id abc123.' }
  }))

  const dialogs = []
  page.on('dialog', (dialog) => dialogs.push(dialog.message()))
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Kitchen tap repair for Maria')
  await page.getByRole('button', { name: 'Send text' }).click()
  const draft = page.locator('#screen article.card')
  await expect(draft).toContainText('282.42')
  await confirmVisit(page, draft.getByRole('button', { name: 'Send 282.42' }))
  await draft.getByRole('button', { name: 'Send 282.42' }).click()
  await expect(page.getByText('PayPal answered 500 INTERNAL_SERVER_ERROR, debug id abc123.')).toBeVisible()
  await expect(draft).toBeVisible()
  expect(dialogs).toEqual([])
})

test('a busy response shows its message', async ({ page }) => {
  await routeState(page)
  await page.route('**/api/agent', (route) => route.fulfill({
    status: 429,
    json: { error: 'busy', message: 'That is enough for today. Try again tomorrow.' }
  }))

  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByText('That is enough for today. Try again tomorrow.')).toBeVisible()
})

test('a junk model reply shows its message', async ({ page }) => {
  await routeState(page)
  await page.route('**/api/agent', (route) => route.fulfill({
    json: { proposal: null, message: 'I did not catch that. Type it or try again.', state: makeState() }
  }))

  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Something unclear')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByText('I did not catch that. Type it or try again.')).toBeVisible()
})

test('a lost connection shows its message', async ({ page }) => {
  await routeState(page)
  await page.route('**/api/agent', (route) => route.abort())

  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('A repair')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByText('No connection. Try again.')).toBeVisible()
})

test('a denied microphone asks the person to type', async ({ page, context }) => {
  await routeState(page)
  await context.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    })
  })

  await page.goto('/?calendar=fallback')
  const talk = page.getByRole('button', { name: 'Hold to talk' })
  await talk.hover()
  await page.mouse.down()
  await expect(page.getByRole('textbox', { name: 'Describe the job' })).toHaveAttribute('placeholder', 'No microphone. Type it instead.')
  await page.mouse.up()
  await expect(page.getByRole('textbox', { name: 'Describe the job' })).toBeFocused()
})

test('replay mode shows the exhausted budget message', async ({ page }) => {
  await routeState(page, makeState(true))

  await page.goto('/?calendar=fallback')
  await expect(page.getByText("Recorded model output. Today's free AI budget is used up.")).toBeVisible()
})

test('an agent message stays visible after state polls', async ({ page }) => {
  let statePolls = 0
  await page.route('**/api/state**', (route) => {
    statePolls++
    return route.fulfill({ json: makeState() })
  })
  await page.route('**/api/agent', (route) => route.fulfill({
    json: { proposal: null, message: 'I did not catch that. Type it or try again.', state: makeState() }
  }))

  await page.goto('/?calendar=fallback')
  await expect.poll(() => statePolls).toBe(1)
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Something unclear')
  await page.getByRole('button', { name: 'Send text' }).click()
  const message = page.getByText('I did not catch that. Type it or try again.')
  await expect(message).toBeVisible()
  await page.waitForTimeout(7000)
  expect(statePolls).toBeGreaterThanOrEqual(3)
  await expect(message).toBeVisible()
})

test('a failed first workspace start shows an error and can be retried', async ({ page }) => {
  let workspaceAttempts = 0
  let ready = false
  await page.route('**/api/state**', (route) => ready
    ? route.fulfill({ json: makeState() })
    : route.fulfill({ status: 404, json: { error: 'not_found', message: 'Not found.' } }))
  await page.route('**/api/workspace', (route) => {
    workspaceAttempts++
    if (workspaceAttempts === 1) return route.fulfill({ status: 429, json: { error: 'busy', message: 'Too many demos were started today. Try again tomorrow.' } })
    ready = true
    return route.fulfill({ json: makeState() })
  })
  await page.goto('/?calendar=fallback')
  await expect(page.getByText('Too many demos were started today. Try again tomorrow.')).toBeVisible()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('tab', { name: 'Today' })).toBeVisible()
  await expect.poll(() => workspaceAttempts).toBe(2)
})
