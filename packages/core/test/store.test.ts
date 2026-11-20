import { MemoryStore } from '../src'
import { runStoreConformance } from '../src/testing'

runStoreConformance('MemoryStore', () => new MemoryStore())
