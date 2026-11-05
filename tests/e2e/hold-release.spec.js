// The calendar acts on money: a deposit that is not paid inside the 2 minute demo hold frees its slot, the deposit
// invoice is cancelled at PayPal, and Priya's waiting job moves into the slot with her deposit waiting for one tap.
// The hold runs on the server's clock, so this test waits the real 2 minutes.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test('an unpaid deposit frees the slot and the waiting job moves in', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/?calendar=fallback')
  await newDemo(page, 0)
  await page.reload()

  const booking = await (await page.request.post('/api/agent', { data: { text: 'Book the bathroom tap for Maria next week.' } })).json()
  expect(booking.proposal.kind).toBe('booking')
  const sent = await page.request.post(`/api/drafts/${booking.proposal.draftId}/send`)
  expect(sent.status()).toBe(200)
  const depositId = (await sent.json()).invoiceId

  await page.reload()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  // The grid opens on this week, and a narrow grid shows one day at a time (today's weekday): look through this
  // week's days, then next week's.
  const held = page.locator(`[data-job-id="${booking.proposal.jobId}"]`).first()
  await page.waitForTimeout(1_500)
  search: for (let week = 0; week < 2; week += 1) {
    if (week) await page.getByRole('button', { name: 'Next week' }).click()
    for (const day of ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
      const button = page.getByRole('button', { name: day, exact: true })
      if (day && await button.isVisible().catch(() => false)) await button.click()
      if (await held.isVisible().catch(() => false)) break search
    }
  }
  await expect(held).toHaveAttribute('data-state', 'held', { timeout: 20_000 })

  // The page polls every 3 s; the poll after the hold runs out releases it.
  await expect(held).toHaveAttribute('data-state', 'released', { timeout: 170_000 })
  await expect(page.locator('[data-job-id="j5"]').first()).toHaveAttribute('data-state', 'offered', { timeout: 15_000 })
  await expect(page.getByRole('button', { name: /Send deposit/ }).first()).toBeVisible()

  const state = await (await page.request.get('/api/state')).json()
  expect(state.ws.invoices[depositId].status).toBe('CANCELLED')
})
