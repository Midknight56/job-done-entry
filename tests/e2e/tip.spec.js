import { confirmVisit } from './visit.js'
// Tip and part payment on one invoice, through the page and PayPal's sandbox page: the draft card's ticks, the buyer
// paying 100.00 now plus a 10.00 tip, and the job staying open with what is left. Signs in as the sandbox buyer (set
// 22 Oct 2026); skipped where no login is on disk.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { shot } from './shots.js'
import { payOnPayPal } from './pay.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const secretsFile = join(homedir(), '.cloudflare', 'paypal-sandbox.local.txt')
const buyer = existsSync(secretsFile)
  ? Object.fromEntries(readFileSync(secretsFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {}

test('the draft card offers a tip by default and part payment on request', async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89.')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByRole('checkbox', { name: 'Allow a tip' })).toBeChecked({ timeout: 40_000 })
  await expect(page.getByRole('checkbox', { name: 'Allow part now, at least 50.00' })).not.toBeChecked()
  // The page redraws the card on every state update; the ticks must survive it.
  await page.getByRole('checkbox', { name: 'Allow part now, at least 50.00' }).check()
  await page.getByRole('checkbox', { name: 'Allow a tip' }).uncheck()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await page.getByRole('tab', { name: 'Today' }).click()
  await expect(page.getByRole('checkbox', { name: 'Allow part now, at least 50.00' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Allow a tip' })).not.toBeChecked()
})

test('part payment with a tip: 100.00 now plus 10.00, the job stays open with 182.42 left', async ({ page, context }) => {
  test.setTimeout(300_000)
  test.skip(!buyer.PAYPAL_SANDBOX_BUYER_PASSWORD, 'no sandbox buyer login on this machine')
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89.')
  await page.getByRole('button', { name: 'Send text' }).click()
  await page.getByRole('checkbox', { name: 'Allow part now, at least 50.00' }).check({ timeout: 40_000 })
  await shot(page, 'tip-draft-ticks')
  await confirmVisit(page, page.getByRole('button', { name: 'Send 282.42' }))
  await page.getByRole('button', { name: 'Send 282.42' }).click()
  const sheet = page.locator('#sheet:not([hidden])')
  await expect(sheet).toBeVisible()
  const invoiceId = await sheet.getAttribute('data-invoice-id')
  const sentState = await (await page.request.get('/api/state')).json()
  const jobId = sentState.ws.invoices[invoiceId].jobId
  await expect(sheet.getByText('Waiting for payment')).toBeVisible({ timeout: 30_000 })
  const payUrl = await sheet.getByRole('link', { name: 'Open the PayPal page' }).getAttribute('href')
  const tab = await context.newPage()
  await tab.goto(payUrl)
  await payOnPayPal(tab, { email: buyer.PAYPAL_SANDBOX_BUYER_EMAIL, password: buyer.PAYPAL_SANDBOX_BUYER_PASSWORD }, {
    part: '100.00',
    tip: '10.00',
    beforePay: async () => {
      await expect(tab.getByText('Minimum due: $50.00').first()).toBeVisible()
      await expect(tab.getByText('Add a tip?')).toBeVisible()
    },
  })
  await tab.close()
  await expect(sheet.getByText('Part paid, 182.42 left')).toBeVisible({ timeout: 120_000 })
  await expect(sheet.getByText('Tip 10.00')).toBeVisible()
  await shot(page, 'tip-part-paid')
  await sheet.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.locator(`[data-job-id="${jobId}"]`).first()).toHaveAttribute('data-state', 'part')
})
