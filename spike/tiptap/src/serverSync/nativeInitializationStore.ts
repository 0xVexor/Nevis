import { initializationKey } from './initializationStore.ts'
import type { InitializationScope } from './initializationStore.ts'
import { cloneDocumentValue } from '../documents/clone.ts'
import type { Page } from '../documents/model.ts'

export interface NativeInitializationBridge {
  active(): boolean
  load(scope: InitializationScope): Promise<number[] | null>
  prepare(scope: InitializationScope, bytes: number[], expectedPage: Page): Promise<number[]>
}

/** Each native command also checks the expected vault while holding the vault lock. */
export class NativeInitializationStore {
  readonly vaultId: string
  readonly bridge: NativeInitializationBridge
  constructor(vaultId: string, bridge: NativeInitializationBridge) {
    if (!vaultId) throw new Error('A fixed vault is required')
    this.vaultId = vaultId
    this.bridge = bridge
  }

  private validate(scope: InitializationScope) {
    initializationKey(scope)
    if (!this.bridge.active() || scope.vaultId !== this.vaultId) throw new Error('Initialization vault unavailable')
  }

  private bytes(value: number[]): Uint8Array {
    if (!Array.isArray(value) || !value.length || value.length > 2 * 1024 * 1024 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))
      throw new Error('Invalid saved initialization')
    return new Uint8Array(value)
  }

  async load(input: InitializationScope): Promise<Uint8Array | null> {
    const scope = { ...input }
    this.validate(scope)
    const value = await this.bridge.load(scope)
    this.validate(scope)
    return value === null ? null : this.bytes(value)
  }

  async prepare(input: InitializationScope, inputBytes: Uint8Array, inputPage: Page): Promise<Uint8Array> {
    const scope = { ...input }
    this.validate(scope)
    const expectedPage = cloneDocumentValue(inputPage)
    if (!expectedPage || expectedPage.id !== scope.documentId) throw new Error('Invalid initialization page')
    const bytes = Array.from(inputBytes)
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('Invalid initialization size')
    const result = await this.bridge.prepare(scope, bytes, expectedPage)
    this.validate(scope)
    const saved = this.bytes(result)
    if (saved.length !== bytes.length || saved.some((byte, index) => byte !== bytes[index])) throw new Error('Initialization storage returned different bytes')
    return saved
  }
}
