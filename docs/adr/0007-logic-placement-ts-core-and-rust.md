# ADR-0007: جای منطق — هستهٔ TypeScript، Rust فقط برای I/O، و سینک پس‌زمینه

- وضعیت: **تصمیم‌شده**
- اطمینان: ۷۵٪
- تاریخ: 2026-11-20
- مرتبط: ADR-0001، ADR-0005، ADR-0013؛ تحقیق: R3 §4-5، R2 §6، `storage-and-sync-options.md` §C؛ legacy: `docs/legacy/0007-web.md`

## زمینه
- اپ قدیمی منطق ادغام را در Rust (`nevis-core`) و WASM داشت تا «ادغام بایت‌به‌بایت» یکسان باشد؛ این دلیل از مقایسهٔ md5 فایل می‌آمد و با CRDT/LWW از بین می‌رود (`storage-and-sync-options.md` §C-2).
- ادیتور (TipTap، Yjs) در JS است. دو پیاده‌سازی Yjs (yjs و yrs) در یک مسیر هزینهٔ parity دارد.
- موبایل: WebView در پس‌زمینه متوقف می‌شود؛ iOS فقط بازه‌های کوتاه سیستمی می‌دهد (`BGAppRefreshTask`، Background Runner حدود ۳۰ ثانیه؛ R3 §4).

## گزینه‌ها
| گزینه | نتیجه |
|---|---|
| **هستهٔ TS در همهٔ پلتفرم‌ها؛ Rust فقط I/O سیستم‌عامل** | **انتخاب.** |
| Rust core + WASM در وب | رد: دو Yjs، دیباگ سخت، Rust+WASM کم‌یاب‌تر؛ دلیل اصلی‌اش منسوخ است. |
| Rust core بومی و وب thin client | رد: وب آفلاین نمی‌شود. |

## تصمیم
1. **`packages/core`** (TypeScript، ESM، strict): HLC، شناسه، envelope و payload، اعمال op (Yjs و LWW)، outbox/inbox، موتور سینک (push/pull/backoff)، compaction، projection، استخراج متن و لینک، نرمال‌سازی فارسی (`packages/text-fa`). **بدون DOM:** `tsconfig` آن `lib: ["ES2023"]` بدون `"DOM"` دارد؛ وابستگی به `window`/`document`/`indexedDB` ممنوع. همه‌چیز سیستمی از «پورت» تزریق می‌شود. پس در Node (آزمون)، Worker و یک محیط JS پس‌زمینه اجرا می‌شود.
2. **پورت‌ها:**
```ts
interface Ports {
  store: Store;                       // ADR-0001
  net: Net;                           // HTTP: request({method, path, query, body}) → {status, headers, body}
  clock: { now(): number };           // ms یونیکس؛ در آزمون قابل کنترل
  random: { bytes(n: number): Uint8Array };
  blobs: BlobStore;                   // بایت پیوست‌ها
  signal: { onWake(cb: () => void): void }; // online، visibility، تایمر
}
```
3. **Rust (Tauri) فقط:** آداپتور SQLite (`store_commit`، خواندن‌ها)، `net_request` (HTTP با توکن دستگاه از keychain)، keychain، فایل (blob، export، آینهٔ Markdown)، dialog، و پل MCP loopback (مثل `mcp.rs` قدیمی: فقط ترابری، منطق در WebView). **هیچ** ادغام، HLC یا فهم payload در Rust.
4. **Go:** فقط سرور (ADR-0006). هیچ کد مشترکی با کلاینت جز **بردارهای آزمون پروتکل** (فایل‌های JSON در `packages/protocol/vectors/`) که هم آزمون TS و هم آزمون Go می‌خوانند.
5. **وب چندتبی:** هر تب هسته را اجرا می‌کند و محلی می‌نویسد. قفل Web Locks `nevis-sync-<ws>` تب leader را تعیین می‌کند؛ فقط leader شبکه (push/pull) و اعمال inbox را انجام می‌دهد. بعد از هر commit، تب نویسنده در BroadcastChannel `nevis-<ws>` پیام `{type:"changed", docs:[…], ents:[…]}` می‌فرستد و تب‌های دیگر updateهای تازه را از store می‌خوانند و به Y.Docهای باز اعمال می‌کنند. دو تبی که یک سند را باز دارند update Yjs را مستقیم هم از BroadcastChannel رد و بدل می‌کنند.
6. **سینک پس‌زمینه (آینده) بدون تغییر هسته — «کوریر»:** چون ارسال و دریافت از اعمال جداست (ADR-0001 بند ۵)، یک کوریر فقط بایت جابه‌جا می‌کند:
   - push: ردیف‌های `outbox` را همان‌طور که هست بفرست؛ با دیدن `seq` حذف کن.
   - pull: opها را در `inbox` بنویس و `meta.cursor` را جلو ببر.
   - هیچ decode payload، ادغام یا HLC. وقتی اپ باز شد، هسته inbox را اعمال می‌کند.
   - **هزینه (صادقانه):** یک پیاده‌سازی دوم از **فقط** حلقهٔ ترابری (حدود ۲۰۰–۴۰۰ خط Rust یا Swift/Kotlin)، زمان‌بند بومی (`BGAppRefreshTask` در iOS، WorkManager در Android)، دسترسی به توکن در keychain و به همان فایل SQLite. با همان بردارهای آزمون پروتکل آزموده می‌شود. نتیجه: «دیگران تغییرات این دستگاه را زودتر می‌بینند» و «باز کردن اپ سریع‌تر است»؛ اعلان یا جست‌وجو روی دادهٔ تازه در پس‌زمینه نه (آن به هسته نیاز دارد). در iOS زمان اجرا را سیستم تعیین می‌کند و تضمین ندارد.
   - شرط لازم که از الان رعایت می‌شود: در موبایل ذخیره‌گاه SQLite بومی است (نه IndexedDB درون WebView)؛ envelope در outbox نهایی و سریال‌شده است؛ cursor و inbox در store هستند.
   - جایگزین: اجرای همین هستهٔ بدون DOM در Background Runner کپسیتور (JS پس‌زمینه). به دلیل نبود IndexedDB و محدودیت ۳۰ ثانیه، فقط اگر کوریر کافی نبود.
7. **دسکتاپ در پس‌زمینه:** وقتی پنجره پنهان است WebView ممکن است throttle شود؛ v1 سینک را فقط وقتی پنجره باز است (حتی پنهان) انجام می‌دهد. بستن پنجره = توقف سینک بعد از flush outbox (حداکثر ۵ ثانیه). اندازه‌گیری در M6.

## پیامدها
- `nevis-core`، `nevis-wasm`، `sync/mod.rs` و موتورهای merge قدیمی کنار گذاشته می‌شوند.
- هر رفتار سینک یک بار در TS نوشته می‌شود؛ تنها تکرار ممکن (کوریر) عمداً بی‌منطق و با بردار آزمون مشترک است.

## چه چیزی تصمیم را برمی‌گرداند
- اگر هستهٔ TS برای ۱۰k صفحه کند بود (شروع > ۲s در M5 یا ingest اولیه > ۶۰s در M12)، اول بهینه‌سازی و Worker؛ انتقال به Rust فقط با اندازه‌گیری.
- اگر مالک سینک پس‌زمینهٔ کامل (با اعمال و اعلان) خواست، هزینهٔ اجرای هسته در JS پس‌زمینه در spike موبایل (M16) سنجیده می‌شود.
