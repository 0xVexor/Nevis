import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { runStoreConformance } from '@nevis/core/testing'
import { IdbStore } from '../src'

let n = 0
// a fresh database (fake-indexeddb is in memory) per conformance test
runStoreConformance('IdbStore on fake-indexeddb', () => new IdbStore({ name: `t${++n}`, indexedDB: new IDBFactory() }))
