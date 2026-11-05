// Pictures of the main screens for people to look at (not a test of behaviour). Runs only with SCREENS=1:
// SCREENS=1 npx playwright test tests/e2e/screens.spec.js. Pictures land in test-results/screens/.
import { test } from '@playwright/test'
import { newDemo } from './demo.js'

test.skip(!process.env.SCREENS, 'pictures only on request')

for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`Bryntum calendar with money states at ${size.width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(size)
    await page.goto('/?calendar=bryntum')
    await newDemo(page, -new Date().getTimezoneOffset())
    const state = await (await page.request.get('/api/state')).json()
    const dave = Object.values(state.ws.invoices).find((i) => i.customerId === 'c2')
    await page.request.post(`/api/invoices/${dave.id}/cash`, { data: { amount: dave.due } })
    const booking = await (await page.request.post('/api/agent', { data: { text: 'Book the bathroom tap for Maria next week.' } })).json()
    await page.request.post(`/api/drafts/${booking.proposal.draftId}/send`)
    await page.reload()
    await page.getByRole('tab', { name: 'Calendar' }).click()
    await page.locator('.b-cal-event-wrap').first().waitFor({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `test-results/screens/bryntum-${size.width}.png` })
  })
}
