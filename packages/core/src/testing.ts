// The vitest binding of the conformance suite: `runStoreConformance('name', () => new MyStore())` inside a test file.
import { describe, expect, it } from 'vitest'
import { storeConformance, type Harness } from './conformance'
import type { Store } from './store'

export function runStoreConformance(name: string, factory: () => Store | Promise<Store>) {
  storeConformance({ describe, it, expect } as unknown as Harness, name, factory)
}
