# ADR-0012: ساختار مخزن، ابزار و راهبرد آزمون

- وضعیت: **تصمیم‌شده**
- اطمینان: ۸۵٪
- تاریخ: 2026-11-20
- مرتبط: همهٔ ADRها؛ PROCESS.md؛ کد قدیمی: `spike/tiptap/package.json` (اسکریپت‌های آزمون چنددستگاهی)

## تصمیم
### ساختار
```
package.json  pnpm-workspace.yaml  tsconfig.base.json  .nvmrc  .npmrc (save-exact=true)
packages/
  protocol/     envelope، payload، parser JSON سخت‌گیر، انواع API، vectors/*.json (مشترک با Go)
  core/         HLC، id، Store (رابط + آداپتور حافظه + آزمون conformance)، اعمال op، سینک، projection، Markdown
  store-idb/    آداپتور IndexedDB
  store-tauri/  سمت TS آداپتور SQLite (فراخوانی فرمان‌های Tauri)
  schema/       schema و extensionهای ProseMirror/TipTap؛ بدون DOM قابل بارگذاری
  text-fa/      نرمال‌سازی و توکن‌سازی؛ vectors.json
  editor/       ادیتور React/TipTap (از M8 با UI قدیمی)
  ui/           کامپوننت‌های مشترک اپ
apps/
  web/          Vite + React PWA
  desktop/      Tauri 2 (src-tauri: store SQLite، net، keychain، fs، mcp)
server/         ماژول Go (cmd/nevis-server، internal/...)
spikes/         m1-editor و spikeهای بعدی (کد دور ریختنی، ولی با آزمون)
tools/          convergence harness، bench، import-legacy
docs/
```
- قاعدهٔ وابستگی: `core` و `protocol` و `text-fa` به هیچ چیز UI/DOM وابسته نیستند؛ `schema` فقط به `@tiptap/core` و `prosemirror-*`. بررسی با `dependency-cruiser` در CI.

### ابزار
- Node LTS (پین در `.nvmrc`؛ نسخه را مهندس در M1 با `node --version` ثبت کند، حداقل 22)، **pnpm** workspace، TypeScript strict با `noUncheckedIndexedAccess`، `exactOptionalPropertyTypes`.
- **Vitest** برای TS؛ **fast-check** برای آزمون خاصیت؛ **Playwright** (Chromium، WebKit، Firefox) برای e2e.
- Lint/format: oxlint + prettier (مثل قدیم).
- Go: نسخهٔ `go.mod`، `go test -race ./...`، `go vet`، `staticcheck`.
- Rust: `cargo test`، `cargo clippy -D warnings`.
- همهٔ وابستگی‌ها با نسخهٔ دقیق؛ lockfile در مخزن؛ ارتقا فقط عمدی.
- فرمان‌های ریشه: `pnpm test` (همهٔ TS)، `pnpm test:e2e`، `pnpm test:go`، `pnpm check` (lint + type + deps)، `pnpm dev:web`، `pnpm dev:server`.
- CI محلی: اسکریپت `pnpm ci` که همه را اجرا می‌کند (مخزن روی GitHub نیست).

### راهبرد آزمون
| لایه | چه چیزی | ابزار |
|---|---|---|
| واحد | HLC، id، parser JSON، فریم payload، LWW، fractional index، نرمال‌ساز فارسی | Vitest |
| خاصیت | HLC یکنواخت و ترتیب کامل؛ LWW جابه‌جایی‌پذیر، شرکت‌پذیر، idempotent؛ projection درخت بدون چرخه | fast-check |
| **harness همگرایی** (`tools/converge`) | N replica هسته با آداپتور حافظه + سرور حافظه‌ای یا Go واقعی؛ عملیات تصادفی (رجیستر، مجموعه، Yjs متن، بعداً عملیات ProseMirror)؛ شبکه با تأخیر، تکرار، بی‌ترتیبی، گم شدن، آفلاین؛ در پایان: projection همه برابر. seed قابل بازتولید در خروجی هر شکست | Vitest + اسکریپت |
| **تزریق crash** | آداپتور store با «شکست در تراکنش k»؛ kill بین نوشتن محلی و push؛ بین push و حذف outbox؛ بین pull و اعمال. ادعا: هیچ op تأییدشده‌ای گم نمی‌شود و هیچ چیز دوبار اعمال نمی‌شود | Vitest؛ Playwright (بستن صفحه حین نوشتن) |
| conformance store | یک مجموعه آزمون روی حافظه، IDB (fake-indexeddb در Node و مرورگر واقعی در Playwright) و SQLite (Rust) | Vitest، cargo test |
| بردار پروتکل | `packages/protocol/vectors/*.json`: envelope معتبر/نامعتبر، پاسخ‌ها؛ هم TS و هم Go می‌خوانند | Vitest، go test |
| سرور | idempotency، 409، 426، 422 clock، هم‌زمانی (۸ pusher، ۴ puller، بدون گپ)، کوری (payload تصادفی)، auth/CSRF | go test -race |
| ادیتور | round-trip schema، `dir`، `blockId`، fuzz ProseMirror+Yjs، اندازهٔ سند بعد از undo | Vitest + Playwright |
| e2e | دو مرورگر/دو تب، آفلاین/آنلاین، همگرایی | Playwright |
| fixture طلایی | updateهای Yjs و باندل‌های ذخیره‌شده؛ پس از هر ارتقا باید همان projection را بدهند | Vitest |
| بنچ | شروع ۱۰k صفحه، IPC، جست‌وجو | `tools/bench` |

### بررسی‌های دستگاه (فقط مالک می‌تواند)
- WebKit در Playwright جانشین Safari است ولی **IME واقعی، ITP، Home Screen و iOS** را نمی‌سنجد.
- هر milestone که به مرورگر/دستگاه مربوط است یک **چک‌لیست مالک** در `docs/checklists/Mn.md` دارد (گام‌ها و نتیجهٔ مورد انتظار) و نتیجه‌ها در گزارش همان milestone ثبت می‌شوند. ماتریس: Chrome macOS، Safari macOS (آخرین)، Safari iOS (تب و Home Screen)، Firefox؛ دسکتاپ: macOS، Windows.
- آزمون بقای ۷ روزهٔ Safari (S6) در M3 شروع می‌شود و نتیجه در گزارش M5 ثبت می‌شود.

## پیامدها
- harness همگرایی و تزریق crash از M2 وجود دارند و در هر milestone گسترش می‌یابند؛ هیچ قابلیت سینک بدون حضور در harness پذیرفته نیست.

## چه چیزی تصمیم را برمی‌گرداند
- اگر pnpm با Tauri مشکل داشت → npm workspaces (هزینهٔ کم).
