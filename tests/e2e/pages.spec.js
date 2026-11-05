import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  const made = await newDemo(page, 0)
  expect(made.ok()).toBeTruthy()
  await page.reload()
})

async function currentState(page) {
  return (await page.request.get('/api/state')).json()
}

test('the customer page updates when Dave pays cash', async ({ page }) => {
  const state = await currentState(page)
  const dave = Object.values(state.ws.invoices).find((invoice) => invoice.customerId === 'c2' && ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(invoice.status))
  expect(dave).toBeTruthy()

  await page.goto(`/customer.html?inv=${encodeURIComponent(dave.id)}`)
  await expect(page.locator('#business')).toHaveText(state.ws.settings.business)
  await expect(page.locator('#amount')).toHaveText('108.00')
  await expect(page.getByText('Scan to pay with PayPal (sandbox)')).toBeVisible()
  await expect(page.locator('#status')).toHaveText('Waiting for payment')
  await expect.poll(() => page.locator('#qr').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0)

  const paid = await page.request.post(`/api/invoices/${encodeURIComponent(dave.id)}/cash`, { data: { amount: dave.due } })
  expect(paid.ok()).toBeTruthy()
  await expect(page.locator('#status')).toContainText('Paid', { timeout: 15000 })
})

test('a shared late invoice has no customer QR image', async ({ page }) => {
  const state = await currentState(page)
  const invoice = Object.values(state.ws.invoices).find((item) => item.shared)
  test.skip(!invoice, 'No shared invoice is available on this server')

  await page.goto(`/customer.html?inv=${encodeURIComponent(invoice.id)}`)
  await expect(page.locator('#qr')).toBeHidden()
  const qr = await page.request.get(`/api/qr/${encodeURIComponent(invoice.id)}`)
  expect(qr.status()).toBe(404)
})

test('settings update the booking hold and start a fresh demo', async ({ page }) => {
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Normal hold 24 hours' }).click()
  expect((await currentState(page)).ws.settings.holdMinutes).toBe(1440)

  await page.getByRole('button', { name: 'Demo hold 2 minutes' }).click()
  expect((await currentState(page)).ws.settings.holdMinutes).toBe(2)

  const answer = await page.request.post('/api/agent', { data: { text: 'Book the bathroom tap for Maria next week.' } })
  expect(answer.ok()).toBeTruthy()
  expect((await answer.json()).proposal.holdMinutes).toBe(2)
})

test('Settings starts a workspace with a new id', async ({ page }) => {
  const before = await currentState(page)
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Start a fresh demo' }).click()
  await expect.poll(async () => (await currentState(page)).ws.id).not.toBe(before.ws.id)
})
