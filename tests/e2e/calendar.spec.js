// The calendar shows money: after a payment the job's block carries the paid state. The same spec runs against the
// Bryntum Calendar and the fallback grid, which share one interface.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

for (const kind of ['bryntum', 'fallback']) {
  test(`${kind}: a payment turns the job green on the calendar`, async ({ page }) => {
    await page.goto(`/?calendar=${kind}`)
    // A fresh demo: Dave's 108.00 invoice is real and open.
    const made = await newDemo(page, -new Date().getTimezoneOffset())
    expect(made.ok()).toBeTruthy()
    await page.reload()
    await page.getByRole('tab', { name: 'Calendar' }).click()
    if (kind === 'bryntum') await page.getByRole('button', { name: 'Week', exact: true }).click()
    const dave = page.locator('[data-job-id="j1"]').first()
    await expect(dave).toHaveAttribute('data-state', 'sent', { timeout: 20_000 })

    const state = await (await page.request.get('/api/state')).json()
    const invoice = Object.values(state.ws.invoices).find((i) => i.customerId === 'c2')
    const paid = await page.request.post(`/api/invoices/${invoice.id}/cash`, { data: { amount: invoice.due } })
    expect(paid.status()).toBe(200)

    await expect(dave).toHaveAttribute('data-state', 'paid', { timeout: 15_000 })
  })
}

test.describe('bryntum mobile style loading', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

  test('bryntum: the top bar stays one row when the styles arrive after the code', async ({ page }) => {
    await page.route('**/vendor/bryntum/**/*.css', async (route) => {
      await new Promise((done) => setTimeout(done, 4000))
      await route.continue()
    })
    await page.goto('/?calendar=bryntum')
    const made = await newDemo(page, -new Date().getTimezoneOffset())
    expect(made.ok()).toBeTruthy()
    await page.reload()
    await page.getByRole('tab', { name: 'Calendar' }).click()
    await page.locator('[data-job-id="j2"]').first().waitFor({ state: 'attached', timeout: 20_000 })
    await page.waitForTimeout(4500)
    const toolbar = page.locator('.b-calendar .b-top-toolbar').first()
    const bar = await toolbar.boundingBox()
    expect(bar.height).toBeLessThan(100)
    const centers = await toolbar.locator('button:visible').evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect()
      return box.y + box.height / 2
    }))
    expect(centers.length).toBeGreaterThan(1)
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1)
  })
})
