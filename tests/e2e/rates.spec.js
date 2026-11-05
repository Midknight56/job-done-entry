// The rate card that learns, through the page: a new call out said with the job shows a one tap change on the
// draft; the tap prices the draft again and the rate card names where the rate came from. A time said next to
// "call out" is not a rate and shows no change.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { shot } from './shots.js'

test('a standalone rate proposal appears without a job', async ({ page }) => {
  const state = {
    now: Date.now(), cursor: 1,
    ws: { id: 'rate-test', tz: 0, settings: { business: 'Elm Street Plumbing', rateCard: { currency: 'USD', callout: '45.00', labourPerHour: '85.00', billingStepMinutes: 15, taxPercent: '8', deposit: '50.00' }, holdMinutes: 2, workHours: [8, 17] }, customers: [], jobs: [], invoices: {}, holds: [], offers: {}, drafts: {}, waiting: [], notices: [], panel: [] },
    budget: { replay: false, appLeft: 950, ipLeft: 380 }
  }
  await page.route('**/api/state**', (route) => route.fulfill({ json: state }))
  await page.route('**/api/agent', (route) => route.fulfill({ json: {
    state, message: null,
    proposal: { kind: 'rate', reason: 'You said the call out changed.', rateChanges: [{ id: 'callout', label: 'Call out', from: '45.00', value: '60.00' }] }
  } }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('call out is 60 now.')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByRole('button', { name: 'Change to 60.00' })).toBeVisible()
})

const MARIA = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89'

test('a new call out said with the job: one tap changes the card and the draft', async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill(`${MARIA}, call out is 60 now.`)
  await page.getByRole('button', { name: 'Send text' }).click()
  const change = page.getByRole('button', { name: 'Change to 60.00' })
  await expect(change).toBeVisible({ timeout: 40_000 })
  await expect(page.locator('.rate-change')).toContainText('Call out on your card: 45.00')
  await expect(page.getByRole('button', { name: 'Send 282.42' })).toBeVisible()
  await shot(page, 'rate-offer')
  await change.click()
  // 60 + 127.50 + 89 = 276.50, plus 8% tax: 298.62.
  await expect(page.getByRole('button', { name: 'Send 298.62' })).toBeVisible()
  await expect(page.locator('.rate-change')).toHaveText('Call out is now 60.00')
  await expect(page.locator('.line-table')).toContainText(/Call out\s*you said 60 on \d+ \w{3}/)
  // The tap survives the page's redraws.
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await page.getByRole('tab', { name: 'Today' }).click()
  await expect(page.getByRole('button', { name: 'Send 298.62' })).toBeVisible()
  await shot(page, 'rate-taken')
  await page.getByRole('tab', { name: 'Settings' }).click()
  await expect(page.locator('.rate-callout')).toContainText(/Call out 60\.00\s*you said 60 on \d+ \w{3}/)
})

test('a time next to call out is not a rate: no change is offered', async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill(`${MARIA}, call out at 10 am.`)
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByRole('button', { name: 'Send 282.42' })).toBeVisible({ timeout: 40_000 })
  await expect(page.locator('.rate-change')).toHaveCount(0)
})
