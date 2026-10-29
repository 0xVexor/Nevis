# Wire protocol and recovery boundaries

Protocol `nevis-drive-sync`, schemaVersion 1. Compact UTF-8 JSON uses sorted object keys. A batch ID is SHA-256 over the Batch with `batchId` empty. Unknown fields, incompatible schemas, sequence collisions, invalid predecessors, unsafe paths and mismatched hashes fail closed. No shared HEAD is overwritten.

A Batch has vaultId, installation deviceId, sequence, previousBatchId, seenFrontier, operations, requiredObjects and optional atomicGroup. Logical captures are split at 200 operations / approximately 512 KiB. A split group cannot materialize until all members exist. An operation carries before/after values, content-addressed full values, or object-field patches with recoverable preimages. Large values above 32 KiB are externalized. Absence uses `{present:false}` and JSON null uses `{present:true,value:null}`.

The installation UUID lives outside portable Vaults and is shared with native database ID allocation. Identity creation uses process and OS locks. The open Vault owns a lifetime OS lock; same-process handles share it. Logical Vault ID is immutable, marker/lock replacement is rejected. Drive format 2 stores the logical ID in `driveVaultId` and leaves legacy `id` empty; old format-1 clients must refuse it. Advisory locks cannot control external editors that ignore them.

Identified Tiptap blocks normalize to a page-wide `$nevisTreeV1` node/parent/order registry, so moving a block and editing its content are separate operations. Unknown/opaque fields are escaped and retained. Three-way sibling-order constraints retain independent inserts. Ambiguous moves/cycles/deleted ancestors retain candidates and produce a structural archive; invalid graphs never apply. Very large ambiguous sibling orders use a conservative archive fallback.

Replay uses sequence/frontier causality with deterministic tie breaks. Conflicts retain full base/A/B, field pointer and provenance. Repeated conflicts cannot reuse an already resolved ID merely because values recur. Resolution is another causal batch, including no-op choices. Keep both creates a fresh ordinary-page ID and fresh block IDs; database rows cannot be cloned by this operation. Manual merge is explicitly disabled in the comparison UI.

Physical layout:

```
Nevis/                         verified root ID, subject, protocol
  descriptor-v1.json          immutable root descriptor (metadata kind root-descriptor)
  <display name>/             verified Vault folder ID + UUID + owner
    descriptor-v1.json        immutable Vault descriptor (metadata kind vault-descriptor)
    streams/                  flat immutable batch objects, logical device streams
    objects/                  flat immutable SHA-256 objects
    checkpoints/              immutable manifest-last publication markers
```

Names do not determine identity. Persisted setup receipts reserve IDs before creating folders/descriptors. Divergent descriptors stop writes; simultaneous identical descriptors are safe. Duplicate roots stop discovery rather than silently selecting one. Explicit verified-root listing/selection and folder inspection are implemented. Bound workspaces cannot silently change roots. Google Picker permission repair for arbitrary folders is not implemented. Flat folders are a deliberate deviation from the plan's physical per-device/prefix hierarchy.

Small immutable markers use one multipart metadata+content request with a 4MiB payload bound. Checkpoint manifests exceeding that bound are rejected before publication; raw history remains. Media is spooled and copied in 64 KiB buffers, uploaded in 8 MiB resumable chunks and downloaded to verified temporary files before rename. Media paths in a Bundle are process-local and are never deserialized from network/Vault JSON. Durable apply receipts contain JSON and hashes; trusted app-data cache paths are re-derived during recovery. JSON remains bounded by 95 MiB/file and 512 MiB aggregate; streaming media download currently has an explicit 5 GiB/object bound. These are implementation limits, not Google's product limits.

Local verified-file hashes have a bounded metadata/inode/time cache (4096 entries, at most 24 hours). Atomic replacement/normal modification invalidates it. Incoming network bytes are independently hashed. The UI's deep check clears the cache. Malicious local changes preserving every identity/metadata signal require a deep check; cached metadata is not an author signature. Initial hashing/copying can still be expensive, particularly in debug builds and while the native writer mutex is held.

A checkpoint binds inventory, full frontier/head/sequence coverage ledger, tombstones, provenance and retained dependency objects. Remote reconstruction precedes publication. Bootstrap chooses a frontier dominating all candidates; incomparable checkpoints require retained streams. A seed plus uncovered tail supports fresh/stale-device replay after covered stream removal in synthetic tests. Dependency objects from older history remain retained.

GC dry-run persists a reproducible journal/inventory proof. Verify checks seed/tail replay and retained objects; stale proof is rejected. Guarded execute and recovery persist/validate a deferred receipt. Destructive GC is compiled out: release, retention, stale-device acknowledgement and rollback/quarantine proofs are not established. There is no remote delete method in this provider, and no automatic retention pruning.

No E2EE or independent author signature exists. SHA-256 detects wrong bytes, not an attacker able to replace both content and all hashes in the Google account.

Checkpoint replay inputs are retained in a deterministic gzip object referenced by `replayArchive` and `retainedObjects`. Compressed object SHA-256, complete batch/sequence coverage, preimage hashes, and reconstructed state/conflicts/provenance/tombstones must match before a seed is used. Decompression stops at 95MiB+1; oversized input is rejected. A folded state alone cannot reproduce canonical three-way merges for a late lower-sorted actor, so new seeds replay the archived inputs plus the uncovered tail. Legacy manifests without that archive are not selected for bootstrap. This preserves correctness but remains full-history replay with growing CPU/JSON memory cost. Destructive compaction remains disabled.

Referenced historical media are recovered at logical capture boundaries from known object hashes and remembered metadata in verified replay inputs, including references in conflict candidates. No remote metadata is invented. Exact reserved literal JSON shapes are escaped; mixed records retain their identity keys. Only an exact blob marker on its matching content-addressed file path represents binary data.

Desktop client import uses the native bounded file reader and OS keyring keyed by the compiled public client ID. Tokens remain in their existing separate keyring item. The client parameter is submitted in both token exchange and refresh, never in the browser authorization URL or Vault. Quota retry deadlines and failure counts are durable; repeated quota failures back off from 60 seconds to one hour, always respecting a longer server deadline, and reset after a successful run.
