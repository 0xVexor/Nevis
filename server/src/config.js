// All settings come from environment variables (Liara: App → Settings → Environment variables).
// Secrets (S3 keys, SESSION_SECRET) are only ever read from here, never from code or the repository.

const MB = 1024 * 1024

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

/** "code1,code2:5" → { code1: Infinity, code2: 5 } (the number is how many accounts a code may create). */
function parseInvites(raw) {
  const out = {}
  for (const part of String(raw ?? '').split(',')) {
    const [code, max] = part.trim().split(':')
    if (code) out[code] = max ? int(max, 1) : Infinity
  }
  return out
}

export function loadConfig(env = process.env) {
  const storage = env.STORAGE || (env.S3_BUCKET ? 's3' : 'disk')
  return {
    port: int(env.PORT, 3000),
    dataDir: env.DATA_DIR || './data',
    production: env.NODE_ENV === 'production',
    storage, // s3 | disk | memory
    s3: {
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION || 'us-east-1',
      pathStyle: env.S3_PATH_STYLE !== 'false',
    },
    secret: env.SESSION_SECRET || '',
    /** the one-instance guard (lock.js); switched off only for development, where a killed server restarts at once */
    lock: env.INSTANCE_LOCK !== 'off',
    /** open: anyone with a proof of work; invite: an invite code is needed; closed: nobody new */
    registration: env.REGISTRATION || 'invite',
    inviteCodes: parseInvites(env.INVITE_CODES),
    maxBlobBytes: int(env.MAX_BLOB_MB, 64) * MB,
    quotaBytes: int(env.QUOTA_MB, 1024) * MB,
    maxVaults: int(env.MAX_VAULTS, 20),
    retentionDays: int(env.RETENTION_DAYS, 30),
    powBits: int(env.POW_BITS, 18),
    /** new accounts per hour from one network address; mobile networks put many people behind one address, so do not set it low */
    registerPerHour: int(env.REGISTER_PER_HOUR, 30),
    backupDelaySec: int(env.BACKUP_DELAY_SEC, 20),
    /** the oldest client protocol this server still talks to */
    minApi: 2,
    api: 2,
  }
}

/** Problems that make a server unsafe to start; returned as messages so that tests can check them. */
export function configProblems(cfg) {
  const bad = []
  if (cfg.secret.length < 32) bad.push('SESSION_SECRET must be set to a random string of at least 32 characters')
  if (!['open', 'invite', 'closed'].includes(cfg.registration)) bad.push('REGISTRATION must be open, invite or closed')
  if (cfg.storage === 's3' && !(cfg.s3.endpoint && cfg.s3.bucket && cfg.s3.accessKeyId && cfg.s3.secretAccessKey)) {
    bad.push('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are all needed for S3 storage')
  }
  if (cfg.registration === 'invite' && Object.keys(cfg.inviteCodes).length === 0) bad.push('REGISTRATION=invite needs INVITE_CODES (comma separated)')
  return bad
}
