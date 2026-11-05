// Pays on PayPal's sandbox invoice page as the sandbox buyer, shared by the happy path, the tip spec and the film.
// An invoice that allows a tip or part payment opens PayPal's pay sheet first ("Continue to Payment"), where the buyer
// picks a part amount and a tip (the part box starts filled with the minimum, so it is cleared first); the field ids are PayPal's own, read from the sandbox page on 28 Oct 2026.

/**
 * Picks one of PayPal's radio buttons, by its label when it has one. A click while the sheet still slides in can be
 * lost (seen on 28 Oct 2026: "Clicking the checkbox did not change its state"), so it tries a few times.
 * @param {import('@playwright/test').Page} tab @param {string} id
 */
async function pick(tab, id) {
  const radio = tab.locator(`#${id}`)
  for (let i = 0; i < 6; i += 1) {
    if (await radio.isChecked().catch(() => false)) return
    await tab.locator(`label[for="${id}"]`).or(radio).first().click({ force: true }).catch(() => {})
    await tab.waitForTimeout(500)
  }
  if (!(await radio.isChecked())) throw new Error(`PayPal's ${id} did not take`)
}

/**
 * @param {import('@playwright/test').Page} tab a page already on the invoice's PayPal link
 * @param {{ email: string, password: string }} login
 * @param {{ part?: string, tip?: string, beforePay?: () => Promise<void> }} [o]
 */
export async function payOnPayPal(tab, login, o = {}) {
  await tab.getByRole('button', { name: 'Close' }).first().click({ timeout: 8_000 }).catch(() => {})
  const toSheet = tab.getByRole('button', { name: 'Continue to Payment' })
  // PayPal's page draws its buttons a few seconds after load; an invoice with neither option has no sheet.
  if (await toSheet.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)) {
    await toSheet.click()
    // The sheet holds the amount choice only when part payment is allowed, and the tip choice only when a tip is.
    await tab.locator('#Radio_payment_option_FULL_AMOUNT').or(tab.locator('#Radio_gratuity_type_noTip')).first().waitFor({ state: 'attached', timeout: 20_000 })
    await tab.waitForTimeout(1_000)
    if (o.part) {
      await pick(tab, 'Radio_payment_option_CUSTOM_AMOUNT')
      await tab.locator('#text-input-custom_amount').fill('')
      await tab.locator('#text-input-custom_amount').pressSequentially(o.part, { delay: 60 })
    }
    // The tip choice starts on an empty percentage, which PayPal refuses (the sign in popup closes at once).
    if (!o.tip && await tab.locator('#Radio_gratuity_type_noTip').count()) await pick(tab, 'Radio_gratuity_type_noTip')
    if (o.tip) {
      await pick(tab, 'Radio_gratuity_type_amount')
      await tab.locator('#text-input-gratuity_amount').fill('')
      await tab.locator('#text-input-gratuity_amount').pressSequentially(o.tip, { delay: 60 })
    }
    await tab.keyboard.press('Tab')
    await tab.waitForTimeout(1_500)
  }
  if (o.beforePay) await o.beforePay()
  const popupPromise = tab.waitForEvent('popup')
  await tab.frameLocator('iframe[title*="PayPal" i]').first().locator('[data-funding-source="paypal"], [aria-label*="PayPal" i]').first().click()
  const popup = await popupPromise
  // The sign in can take a moment to settle in the popup (seen 28 Oct 2026: filling at once found the page closed).
  await popup.waitForLoadState('domcontentloaded')
  await popup.waitForTimeout(5_000)
  if (await popup.locator('#email').isVisible().catch(() => false)) {
    await popup.locator('#email').fill(login.email)
    if (await popup.locator('#btnNext').isVisible().catch(() => false)) await popup.locator('#btnNext').click()
    await popup.locator('#password').waitFor({ timeout: 20_000 })
    await popup.locator('#password').fill(login.password)
    await popup.locator('#btnLogin').click()
    await popup.waitForTimeout(8_000)
  }
  try {
    await popup.locator('#payment-submit-btn').or(popup.getByRole('button', { name: /complete purchase/i })).first().click({ timeout: 90_000 })
  } catch (e) {
    await popup.screenshot({ path: 'test-results/pay-popup-failure.png' }).catch(() => {})
    throw e
  }
  await tab.waitForTimeout(5_000)
}
