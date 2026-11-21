import { MemoryBlobStore } from '../src'
import { runBlobStoreConformance } from '../src/testing'

runBlobStoreConformance('MemoryBlobStore', () => new MemoryBlobStore())
