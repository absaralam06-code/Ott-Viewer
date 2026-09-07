import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests import from 'node:test' — use the pool that supports this
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': new URL('./', import.meta.url).pathname.replace(/\/$/, ''),
    },
  },
})
