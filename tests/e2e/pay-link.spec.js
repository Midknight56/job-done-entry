import { test, expect } from '@playwright/test'

test('an unpaid invoice keeps its PayPal link when the QR is unavailable', async ({ page }) => {
  const state = {
    now: Date.now(), cursor: 1,
    ws: { id: 'pay-test', tz: 0, settings: { business: 'Elm Street Plumbing', rateCard: { currency: 'USD', callout: '45.00', labourPerHour: '85.00', billingStepMinutes: 15, taxPercent: '8', deposit: '50.00' }, holdMinutes: 2, workHours: [8, 17] },
      customers: [{ id: 'c1', name: 'Maria Lopez', address: '14 Elm Street', email: 'maria@example.com' }], jobs: [],
      invoices: { i1: { id: 'i1', customerId: 'c1', status: 'SENT', total: '45.00', due: '45.00', hasQr: false, payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST', sentAt: Date.now(), shared: false } },
      holds: [], offers: {}, drafts: {}, waiting: [], notices: [], panel: [] },
    budget: { replay: false, appLeft: 950, ipLeft: 380 }
  }
  await page.route('**/api/state**', (route) => route.fulfill({ json: state }))
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Owed' }).click()
  await page.getByRole('button', { name: /Maria Lopez/ }).click()
  const link = page.getByRole('link', { name: 'Open the PayPal page' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST')
})
