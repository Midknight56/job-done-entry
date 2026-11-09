// When an unpaid hold runs out, the Calendar shows why the freed slot went to a waiting job: the cancelled deposit
// invoice, every waiting job considered with its reason, and the stage ("Slot offered" until a deposit is sent).
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test('a freed slot explains every waiting job it considered', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/?calendar=fallback')
  await newDemo(page, 0)
  await page.reload()

  const booking = await (await page.request.post('/api/agent', { data: { text: 'Book the bathroom tap for Maria next week.' } })).json()
  expect(booking.proposal.kind).toBe('booking')
  const slotDay = new Date(booking.proposal.slot.start).getUTCDay()
  const otherDay = slotDay === 5 ? 4 : 5

  // The waiting list in order: too long, not free that day, fits.
  expect((await page.request.post('/api/waiting/j5/remove')).status()).toBe(200)
  for (const entry of [
    { customerId: 'c2', summary: 'Bathroom refit', hours: 3, free: 'any' },
    { customerId: 'c3', summary: 'Radiator check', hours: 1, free: [otherDay] },
    { customerId: 'c4', summary: 'Leak under the sink', hours: 1, free: 'any' },
  ]) expect((await page.request.post('/api/waiting', { data: entry })).status()).toBe(200)

  const sent = await page.request.post(`/api/drafts/${booking.proposal.draftId}/send`)
  expect(sent.status()).toBe(200)
  const depositId = (await sent.json()).invoiceId
  expect((await page.request.post(`/api/holds/${booking.proposal.jobId}/expire`)).status()).toBe(200)

  await page.reload()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const panel = page.locator('details.recovery')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('summary')).toHaveText('Why this slot was offered')
  await expect(panel).toContainText(`Deposit invoice ${depositId} cancelled.`)
  await expect(panel.locator('li')).toHaveCount(3)
  await expect(panel.locator('li').nth(0)).toContainText('Too long: Dave Chen, 3 h. Dave needs 3 hours.')
  await expect(panel.locator('li').nth(1)).toContainText('Not free: Sam Okafor, 1 h. Sam is not free then.')
  await expect(panel.locator('li').nth(2)).toHaveText('Chosen: Priya Nair, 1 h. Priya was first on the waiting list who fits 1 hour and is free then.')
  await expect(panel.locator('.recovery-stage')).toHaveText('Slot offered')
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/why-this-slot-was-offered.png' })

  // Sending the offer's deposit moves the stage on; no money is counted for the offer alone.
  await page.getByRole('button', { name: /Send deposit/ }).first().click()
  await expect(panel.locator('.recovery-stage')).toHaveText('Deposit requested', { timeout: 20_000 })
  const narrow = await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  expect(narrow).toBe(true)
})
