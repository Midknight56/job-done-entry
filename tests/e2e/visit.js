import { expect } from '@playwright/test'

/** Confirm the displayed visit, then wait for this invoice's Send button. */
export async function confirmVisit(page, send = page.getByRole('button', { name: /^Send \d/ })) {
  await expect(send).toBeVisible({ timeout: 40_000 })
  const form = send.locator('..').locator('.visit-form')
  if (await form.isVisible()) await form.getByRole('button', { name: 'Confirm visit', exact: true }).click()
  await expect(send).toBeEnabled({ timeout: 40_000 })
}
