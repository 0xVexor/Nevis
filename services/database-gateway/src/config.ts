// Environment parsing. Everything has a safe default except the owner token, which must be provided (or created by the dev bootstrap).
export interface Config {
  host: string
  port: number
  dbPath: string
  publicUrl: string
  ownerToken: string
  webhookAllowlist: string[]
  connectionsFile: string
  maxBody: number
  ratePerMinute: number
  dev: boolean
  /** a published form version stays valid for submissions this long after a newer one replaced it */
  staleVersionMs: number
  /** a job whose published context is older than this is paused instead of run on guessed values */
  freshnessMs: number
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const host = env.GATEWAY_HOST || '127.0.0.1'
  const dev = env.GATEWAY_DEV === '1'
  if (dev && !LOOPBACK.has(host)) throw new Error('GATEWAY_DEV=1 is only allowed on a loopback address')
  const num = (v: string | undefined, d: number, min: number, max: number) => {
    const n = v === undefined || v === '' ? d : Number(v)
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`invalid number: ${v}`)
    return Math.trunc(n)
  }
  const ownerToken = env.GATEWAY_OWNER_TOKEN ?? ''
  if (ownerToken && ownerToken.length < 32) throw new Error('GATEWAY_OWNER_TOKEN must be at least 32 characters')
  const port = num(env.GATEWAY_PORT, 8787, 0, 65535)
  return {
    host,
    port,
    dbPath: env.GATEWAY_DB || './data/gateway.sqlite',
    publicUrl: (env.GATEWAY_PUBLIC_URL || `http://${host}:${port}`).replace(/\/+$/, ''),
    ownerToken,
    webhookAllowlist: (env.GATEWAY_WEBHOOK_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    connectionsFile: env.GATEWAY_CONNECTIONS_FILE || '',
    maxBody: num(env.GATEWAY_MAX_BODY, 1_048_576, 1024, 50_000_000),
    ratePerMinute: num(env.GATEWAY_RATE_PER_MINUTE, 30, 1, 100000),
    dev,
    staleVersionMs: 7 * 24 * 3600_000,
    freshnessMs: 5 * 60_000,
  }
}
