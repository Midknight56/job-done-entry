// Pays a Job Done sandbox invoice as a sandbox buyer, headless:
//   node tools/pay_invoice.mjs <invoiceId> [BUYER|BUYER2|BUYER3] [--part 50.00] [--tip 10.00]
// --part pays that much of an invoice that allows part payment; --tip adds a tip on an invoice that allows tips.
// For tests and the demo only; the owner allowed sandbox buyer sign in on 22 Oct 2026. It reads the buyer's login from
// the secrets folder and never prints it. Each step saves a picture in tools/out/pay/ and prints only page titles,
// button names and HTTP codes. It stops at any security challenge; it never tries to get past one.

import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null }
const part = flag('--part')
const tip = flag('--tip')
const [invoiceId, who = 'BUYER'] = args
if (!invoiceId) throw new Error('usage: node tools/pay_invoice.mjs <invoiceId> [BUYER|BUYER2|BUYER3] [--part 50.00] [--tip 10.00]')
const secrets = Object.fromEntries(
  readFileSync(join(homedir(), '.cloudflare', 'paypal-sandbox.local.txt'), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const email = secrets[`PAYPAL_SANDBOX_${who}_EMAIL`]
const password = secrets[`PAYPAL_SANDBOX_${who}_PASSWORD`]
if (!email || !password) throw new Error(`no login for ${who} in the secrets file`)
const out = join(process.cwd(), 'tools', 'out', 'pay')
mkdirSync(out, { recursive: true })

const API = 'https://api-m.sandbox.paypal.com'
async function token() {
  const basic = Buffer.from(`${secrets.PAYPAL_SANDBOX_CLIENT_ID}:${secrets.PAYPAL_SANDBOX_SECRET}`).toString('base64')
  const r = await fetch(`${API}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  return (await r.json()).access_token
}
async function invoice(t) {
  const r = await fetch(`${API}/v2/invoicing/invoices/${invoiceId}`, { headers: { authorization: `Bearer ${t}` } })
  return { status: r.status, json: await r.json() }
}

const t = await token()
const before = await invoice(t)
console.log(`invoice ${invoiceId}: HTTP ${before.status}, status ${before.json.status}, due ${before.json.due_amount?.value}`)
if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(before.json.status)) process.exit(0)
const url = before.json.detail.metadata.recipient_view_url

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
let n = 0
async function snap(label) {
  n++
  await page.screenshot({ path: join(out, `${String(n).padStart(2, '0')}-${label}.png`) })
  const buttons = await page.getByRole('button').evaluateAll((els) => els.map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 12))
  console.log(`step ${n} ${label}: "${(await page.title()).slice(0, 60)}"; buttons: ${JSON.stringify(buttons)}`)
}
async function challenged() {
  const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase()
  return text.includes('captcha') || text.includes('security challenge') || text.includes("i'm not a robot")
}
async function clickFirst(names) {
  for (const name of names) {
    const b = page.getByRole('button', { name }).or(page.getByRole('link', { name })).first()
    if (await b.isVisible().catch(() => false)) { await b.click(); return name.toString() }
  }
  return null
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  // The cookie banner is closed with its X: non essential cookies are not accepted.
  await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {})
  await snap('invoice-page')
  // An invoice that allows a tip or part payment opens PayPal's pay sheet first, where the buyer picks the amounts.
  const sheet = page.getByRole('button', { name: 'Continue to Payment' })
  if (await sheet.isVisible().catch(() => false)) {
    await sheet.click()
    await page.waitForTimeout(3000)
    if (part) {
      await page.locator('#Radio_payment_option_CUSTOM_AMOUNT').check({ force: true })
      await page.locator('#text-input-custom_amount').fill(part)
    }
    if (tip) {
      await page.locator('#Radio_gratuity_type_amount').check({ force: true })
      await page.locator('#text-input-gratuity_amount').fill(tip)
    }
    await page.keyboard.press('Tab')
    await page.waitForTimeout(1500)
    await snap('pay-sheet')
  }
  // The PayPal button lives in PayPal's own frame and opens the buyer's sign in as a popup.
  const frame = page.frameLocator('iframe[title*="PayPal" i]').first()
  const popupPromise = page.waitForEvent('popup', { timeout: 30000 })
  await frame.locator('[data-funding-source="paypal"], [aria-label*="PayPal" i]').first().click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await popup.waitForTimeout(5000)
  const shot = async (label) => {
    n++
    await popup.screenshot({ path: join(out, `${String(n).padStart(2, '0')}-${label}.png`) }).catch(() => {})
    const buttons = await popup.getByRole('button').evaluateAll((els) => els.map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 12)).catch(() => [])
    console.log(`step ${n} ${label}: "${(await popup.title().catch(() => '')).slice(0, 60)}"; buttons: ${JSON.stringify(buttons)}`)
  }
  await shot('popup')
  const text = async () => (await popup.locator('body').innerText().catch(() => '')).toLowerCase()
  if ((await text()).includes('captcha')) throw new Error('security challenge shown; stopped')
  if (await popup.locator('#email').isVisible().catch(() => false)) {
    await popup.locator('#email').fill(email)
    if (await popup.locator('#btnNext').isVisible().catch(() => false)) await popup.locator('#btnNext').click()
    await popup.locator('#password').waitFor({ timeout: 20000 })
    await popup.locator('#password').fill(password)
    await popup.locator('#btnLogin').click()
    await popup.waitForTimeout(8000)
    await shot('after-login')
    if ((await text()).includes('captcha')) throw new Error('security challenge shown; stopped')
  }
  const payButton = popup.locator('#payment-submit-btn').or(popup.getByRole('button', { name: /^(pay|pay now|complete purchase)/i })).first()
  await payButton.waitFor({ timeout: 30000 })
  await payButton.click()
  await page.waitForTimeout(12000)
  await snap('after-pay')
} catch (e) {
  console.log('stopped:', String(e.message || e).slice(0, 200))
  await snap('stopped').catch(() => {})
} finally {
  await browser.close()
}
const after = await invoice(t)
console.log(`invoice ${invoiceId}: HTTP ${after.status}, status ${after.json.status}, due ${after.json.due_amount?.value}`)
