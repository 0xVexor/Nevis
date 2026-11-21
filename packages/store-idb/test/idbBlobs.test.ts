import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { runBlobStoreConformance } from '@nevis/core/testing'
import { IdbBlobStore } from '../src'

let n = 0
runBlobStoreConformance('IdbBlobStore on fake-indexeddb', () => new IdbBlobStore({ name: `b${++n}`, indexedDB: new IDBFactory() }))
