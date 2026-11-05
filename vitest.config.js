import { defineConfig } from 'vitest/config'

// The coverage floor: a change that drops below it fails `npm run coverage`.
const thresholds = { lines: 100, functions: 100, statements: 99, branches: 97 }

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/live/**/*.test.js'],
    coverage: { thresholds },
  },
})
