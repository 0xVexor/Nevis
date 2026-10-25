// Where the bytes of files live. Three implementations of the same small interface:
//   S3Storage     production (any S3 compatible store, e.g. Liara object storage)
//   DiskStorage   local development without an S3 account
//   MemStorage    tests
// Keys are plain strings like "v/<vault>/b/ab/<sha256>".

import { Readable } from 'node:stream'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class MemStorage {
  constructor() {
    this.map = new Map()
  }
  async put(key, buf) {
    this.map.set(key, Buffer.from(buf))
  }
  async get(key) {
    const b = this.map.get(key)
    return b ? Readable.from([b]) : null
  }
  async read(key) {
    return this.map.get(key) ?? null
  }
  async has(key) {
    return this.map.has(key)
  }
  async del(key) {
    this.map.delete(key)
  }
  async list(prefix) {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

export class DiskStorage {
  constructor(dir) {
    this.dir = path.resolve(dir)
  }
  file(key) {
    const f = path.resolve(this.dir, key)
    if (!f.startsWith(this.dir + path.sep)) throw new Error('bad key')
    return f
  }
  async put(key, buf) {
    const f = this.file(key)
    await mkdir(path.dirname(f), { recursive: true })
    const tmp = `${f}.${process.pid}.tmp`
    await writeFile(tmp, buf)
    await rename(tmp, f)
  }
  async get(key) {
    const b = await this.read(key)
    return b ? Readable.from([b]) : null
  }
  async read(key) {
    try {
      return await readFile(this.file(key))
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
  async has(key) {
    try {
      await stat(this.file(key))
      return true
    } catch {
      return false
    }
  }
  async del(key) {
    await rm(this.file(key), { force: true })
  }
  async list(prefix) {
    const out = []
    const walk = async (d) => {
      let entries = []
      try {
        entries = await readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else out.push(path.relative(this.dir, p).split(path.sep).join('/'))
      }
    }
    await walk(this.dir)
    return out.filter((k) => k.startsWith(prefix) && !k.endsWith('.tmp')).sort()
  }
}

export async function createS3Storage(cfg) {
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.pathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // many S3 compatible stores do not know the newer "flexible checksum" headers
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 4,
  })
  const Bucket = cfg.bucket
  const missing = (e) => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
  return {
    async put(Key, buf) {
      await client.send(new PutObjectCommand({ Bucket, Key, Body: buf, ContentLength: buf.length, ContentType: 'application/octet-stream' }))
    },
    async get(Key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key }))
        return r.Body
      } catch (e) {
        if (missing(e)) return null
        throw e
      }
    },
    async read(Key) {
      const body = await this.get(Key)
      if (!body) return null
      const chunks = []
      for await (const c of body) chunks.push(c)
      return Buffer.concat(chunks)
    },
    async has(Key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key }))
        return true
      } catch (e) {
        if (missing(e)) return false
        throw e
      }
    },
    async del(Key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key }))
    },
    async list(Prefix) {
      const out = []
      let ContinuationToken
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }))
        for (const o of r.Contents ?? []) out.push(o.Key)
        ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (ContinuationToken)
      return out.sort()
    },
  }
}

export async function createStorage(cfg) {
  if (cfg.storage === 's3') return createS3Storage(cfg.s3)
  if (cfg.storage === 'memory') return new MemStorage()
  return new DiskStorage(path.join(cfg.dataDir, 'blobs'))
}

export const blobKey = (vaultId, sha) => `v/${vaultId}/b/${sha.slice(0, 2)}/${sha}`
