import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { runBlobStoreConformance } from '@nevis/core/testing'
import { IdbBlobStore } from '../src'

let n = 0
runBlobStoreConformance('IdbBlobStore on fake-indexeddb', () => new IdbBlobStore({ name: `b${++n}`, indexedDB: new IDBFactory() }))

// WebKit builds that cannot keep a Blob in IndexedDB: the same contract with the bytes stored as an ArrayBuffer.
runBlobStoreConformance('IdbBlobStore, bytes stored as ArrayBuffer (the WebKit fallback)', () => new IdbBlobStore({ name: `ab${++n}`, indexedDB: new IDBFactory(), forceBuffer: true }))
