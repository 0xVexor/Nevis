# Database performance measurements

Reproduce: `node db/bench/database-bench.mjs 1000 10000 100000` (Node 24).

Device: Intel Core i7-7700 @ 3.6 GHz, 8 threads, 26 GB RAM, Windows 11, Node v24.18.1. Three properties (status, number, date), one Source,
**in-memory adapter** (no disk, no UI, no IndexedDB, no Tauri). One run per size, so treat the numbers as orders of magnitude, not p95s.

| Rows | Batched create (500 per commit) | First page (50) | Filter `cost >= 500` | Sort by cost desc | Group by status | Search |
|---|---|---|---|---|---|---|
| 1 000 | 124 ms (0.12 ms/row) | 2.6 ms | 2.5 ms | 5.4 ms | 7.1 ms | 9 ms |
| 10 000 | 2.3 s (0.23 ms/row) | 11 ms | 8 ms | 41 ms | 31 ms | 42 ms |
| 100 000 | 173 s (1.7 ms/row)¹ | 128 ms | 115 ms | 505 ms | 331 ms | 434 ms |

¹ measured before the final run on the same code; a 100k import is a one-off operation and is committed in 500-row batches.

What was found and fixed while measuring:

* `row.create` rescanned and re-sorted every page of the Source for each new row (quadratic: 3.5 ms/row at 10k). It now keeps per-Source
  statistics for the duration of one commit (`Draft.rowStats`): 0.2 ms/row at 10k.
* Appended sort keys grew by a character every few rows and overflowed the stack near 10k rows. Appends now use a length-headed counter
  (`model/ids.ts: appendKey`): 200 000 appends stay ≤ 5 characters (`db/tests/database/ids.test.mjs`).

Not measured (and therefore not claimed): cold open of a large Vault, IndexedDB / Tauri commit latency, 20/100 properties, relation
density, graph layout time for a database, scroll dropped frames, peak memory. A Worker for heavy queries was not built: the largest
measured query is half a second at 100k rows, and the table view only asks for a page at a time.
