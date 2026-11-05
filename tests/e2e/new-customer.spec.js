import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test('saves a new customer and resumes the same job as a priced draft', async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, 0)
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Kitchen tap for Tom Baker, hour and a half, the tap was 89.')
  await page.getByRole('button', { name: 'Send text' }).click()
  const card = page.locator('.card')
  await expect(card.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Tom Baker')
  await card.getByRole('textbox', { name: 'Address', exact: true }).fill('12 Main Street')
  await card.getByRole('textbox', { name: 'Email', exact: true }).fill('tom@gmail.com')
  await card.getByRole('button', { name: 'Save customer' }).click()
  await expect(card.getByRole('alert')).toContainText('example.com')
  await expect(card.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue('12 Main Street')
  await card.getByRole('textbox', { name: 'Email', exact: true }).fill('tom@example.com')
  await card.getByRole('button', { name: 'Save customer' }).click()
  await expect(card.getByRole('heading', { name: 'Tom Baker', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Send 282.42', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Describe the job' })).toHaveValue('')
  const state = await (await page.request.get('/api/state')).json()
  expect(state.ws.customers.find((person) => person.name === 'Tom Baker')).toMatchObject({ email: 'tom@example.com', address: '12 Main Street' })
})
