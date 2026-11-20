import { defineConfig } from 'vitest/config'
// ADR-0003 §9: the schema loads in plain Node, with no DOM.
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } })
