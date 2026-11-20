# ADR-0001: مدل ذخیره‌سازی و منبع حقیقت

- وضعیت: **تصمیم‌شده، منتظر spike** (بخش دسکتاپ با M6 قطعی می‌شود)
- اطمینان: ۸۰٪ برای مدل کلی، ۶۵٪ برای «SQLite در دسکتاپ به‌جای IndexedDB در WebView»
- تاریخ: 2026-11-20
- مرتبط: ADR-0002، ADR-0005، ADR-0007؛ تحقیق: R2، R3 §3 و §5، `storage-and-sync-options.md` §A و §C-3 و §3-4

## زمینه
- آفلاین‌فرست اولویت اول است: هر تغییر اول محلی و پایدار نوشته می‌شود، بعد ارسال می‌شود (VISION قید ۲).
- منطق داده و سینک باید یک بار نوشته شود (قید ۳). ذخیره‌گاه هر پلتفرم فرق دارد: مرورگر فقط IndexedDB/OPFS دارد؛ دسکتاپ و موبایل فایل و SQLite دارند.
- در Safari، ماندگاری داده تضمین‌شده نیست (سقف ۷ روزه ITP برای تب مرورگر، `persist()` با heuristic؛ R2 §1). SQLite-WASM روی OPFS در Safari/iOS گزارش‌های قفل ماندگار و نیاز COOP/COEP دارد (R2 §4؛ `storage-and-sync-options.md` §C-3).
- در Tauri، origin وب‌ویو با `use_https_scheme` و بین پلتفرم‌ها فرق می‌کند؛ تغییر origin یعنی IndexedDB خالی (R3 §3). رفتار eviction در WKWebView تأییدنشده است (R2 §7).
- سینک پس‌زمینهٔ موبایل در آینده باید بدون تغییر هسته ممکن باشد (ADR-0007).

## گزینه‌ها
| گزینه | نتیجه |
|---|---|
| (الف) فایل‌ها (Markdown/JSON per page) منبع حقیقت و بستر سینک | **رد.** ریشهٔ heuristicهای اپ قدیمی (hold delete، resurrection، md5 سه‌طرفه). Markdown جهت هر بلوک و جدول پیچیده را نگه نمی‌دارد (R6 §1). |
| (ب) یک فایل SQLite که خودش سینک شود (Drive/iCloud) | **رد.** WAL با سینک فایل خراب می‌شود (ADR-0003 قدیمی؛ SiYuan هم هشدار می‌دهد). |
| (ج) SQLite-WASM روی OPFS در وب | **رد برای منبع حقیقت در v1.** Safari/iOS اثبات‌نشده؛ `opfs-sahpool` چندتب ندارد؛ `opfs` نیاز COOP/COEP دارد. شاید بعداً برای ایندکس مشتق. |
| (د) IndexedDB در همهٔ پلتفرم‌ها، حتی در WebView دسکتاپ | **رد برای دسکتاپ.** دلیل‌ها: وابستگی داده به origin وب‌ویو؛ eviction نامعلوم WKWebView؛ دادهٔ دسکتاپ نباید در پوشهٔ داخلی موتور مرورگر گم باشد؛ کوریر پس‌زمینهٔ بومی (ADR-0007) به IndexedDB درون WebView دسترسی ندارد. |
| **(هـ) یک رابط `Store` در هستهٔ TS، با دو آداپتور: IndexedDB (وب) و SQLite از راه Rust (دسکتاپ، بعداً موبایل)؛ به‌علاوهٔ آداپتور حافظه برای آزمون** | **انتخاب.** |

## تصمیم
1. **منبع حقیقت روی هر دستگاه = پایگاه محلی همان دستگاه.** سرور منبع حقیقت نیست؛ لاگ سرور «حافظهٔ مشترک» است و از روی آن هر دستگاه بازسازی‌پذیر است (به‌جز outbox ارسال‌نشده).
2. **رابط واحد `Store`** در `packages/core`. منطق (HLC، LWW، Yjs، سینک) فقط با این رابط کار می‌کند. آداپتورها فقط جدول‌ها را می‌نویسند و می‌خوانند؛ تنها منطق مجاز در آداپتور «نوشتن رجیستر اگر HLC جدیدتر است» است (برای اتمی بودن در یک تراکنش). این قاعده با یک مجموعه آزمون مشترک (conformance) روی همهٔ آداپتورها آزموده می‌شود.
3. **جدول‌های منطقی** (در IndexedDB = object store؛ در SQLite = جدول):

```sql
-- حالت
doc_state   (doc TEXT PRIMARY KEY, state BLOB, max_sv INTEGER)      -- Yjs V1، فشرده‌شدهٔ محلی
doc_update  (doc TEXT, k INTEGER, upd BLOB, PRIMARY KEY(doc,k))     -- دنبالهٔ updateهای ادغام‌نشده
field       (ent TEXT, f TEXT, val TEXT, hlc TEXT, PRIMARY KEY(ent,f)) -- رجیستر LWW؛ val = JSON
event       (id TEXT PRIMARY KEY, ent TEXT, kind TEXT, hlc TEXT, body TEXT) -- رویداد تغییرناپذیر
-- سینک
outbox      (op TEXT PRIMARY KEY, env TEXT, blobs TEXT, created INTEGER) -- envelope سریال‌شدهٔ نهایی
inbox       (seq INTEGER PRIMARY KEY, env TEXT)                      -- opهای کشیده‌شده که هنوز اعمال نشده‌اند
quarantine  (seq INTEGER PRIMARY KEY, env TEXT, reason TEXT)         -- opهای نامعتبر (ADR-0005)
blob        (hash TEXT PRIMARY KEY, size INTEGER, mime TEXT, local INTEGER, remote INTEGER)
meta        (k TEXT PRIMARY KEY, v TEXT)                             -- cursor، deviceId، آخرین HLC، نسخهٔ store
-- مشتق (هرگز سینک نمی‌شود، همیشه بازسازی‌پذیر)
derived_*   (ایندکس جست‌وجو، لینک‌ها، تسک‌ها، وضعیت فلش‌کارت)
```

4. **هر تغییر محلی = یک تراکنش اتمی** که حالت (`doc_update` یا `field` یا `event`)، ردیف `outbox` و `meta.hlc` را با هم می‌نویسد. هیچ حالت «نصفه» وجود ندارد.
5. **مسیر دریافت دومرحله‌ای است:** (الف) کشیدن از سرور: opها در `inbox` نوشته می‌شوند و `meta.cursor` در همان تراکنش جلو می‌رود؛ (ب) اعمال: هسته هر op را از `inbox` اعمال و در همان تراکنش حذف می‌کند. اعمال تکراری بی‌اثر است (ADR-0004، ADR-0005). این جداسازی هم crash-safe است و هم اجازهٔ کوریر بومی پس‌زمینه را می‌دهد.
6. **وب:** IndexedDB، یک پایگاه per workspace با نام `nevis-<workspaceId>`. همهٔ تب‌ها می‌نویسند؛ فقط تب leader (Web Locks) شبکه و اعمال inbox را انجام می‌دهد؛ تب‌ها با BroadcastChannel خبر می‌گیرند (ADR-0007). `navigator.storage.persist()` در اولین ورود درخواست و وضعیتش در UI نشان داده می‌شود.
7. **دسکتاپ:** فایل SQLite (WAL) در پوشهٔ دادهٔ اپ، با `rusqlite` در Rust. رابط IPC **یک فرمان per تراکنش** است (`store_commit(batch)` و چند فرمان خواندن)، نه SQL دلخواه از TS. updateهای Yjs قبل از نوشتن در حافظه ادغام می‌شوند (ADR-0003: حداکثر ۳۰۰ms یا رویداد `visibilitychange`/`pagehide`/بستن).
8. **از دست رفتن دادهٔ محلی:** اگر پایگاه محلی پاک شد (eviction در Safari)، اپ آن را تشخیص می‌دهد (`meta.deviceId` نیست ولی کاربر وارد شده) و از سرور بازسازی می‌کند. outbox ارسال‌نشده تنها چیزی است که از دست می‌رود؛ UI تعداد opهای ارسال‌نشده را همیشه نشان می‌دهد.
9. **مهاجرت ذخیره‌گاه محلی:** `meta.storeVersion`. اگر outbox خالی است، مهاجرت ناموفق یا نسخهٔ ناشناخته = پاک کردن و بازسازی از سرور. اگر outbox خالی نیست، هرگز پاک نکن؛ اول outbox را بفرست.

## پیامدها
- دو آداپتور (IDB، SQLite) به‌علاوهٔ حافظه؛ هر کدام حدود چند صد خط بدون منطق ادغام. آزمون conformance مشترک تنها ضامن یکسانی است.
- دادهٔ وب در Safari تب معمولی ممکن است پاک شود؛ سرور پشتیبان است. این باید به مالک گفته شود (OPEN-QUESTIONS).
- هر نوشتن در دسکتاپ یک IPC دارد؛ هزینه باید اندازه‌گیری شود (M6).

## چه چیزی تصمیم را برمی‌گرداند (و آزمونش)
| شرط برگشت | آزمون | milestone |
|---|---|---|
| IPC دسکتاپ کند: p95 `store_commit` در تایپ سریع > ۵۰ms | بنچ تایپ ۱۰ کلید/ثانیه به مدت ۶۰ ثانیه روی macOS و Windows | M6 |
| IndexedDB در Safari/iOS داده را در kill کردن یا background از دست می‌دهد | چک‌لیست دستگاه مالک: ۲۰ بار kill حین تایپ؛ صفر از دست رفتن به‌جز پنجرهٔ ۳۰۰ms | M3 |
| IndexedDB برای ۱۰k صفحه کند: شروع تا فهرست > ۲s | بنچ با دادهٔ مصنوعی ۱۰k صفحه | M5 |
اگر IPC کند بود: اول batch بزرگ‌تر؛ اگر کافی نبود، IndexedDB در WebView دسکتاپ با origin ثابت (`use_https_scheme` ثابت و آزمون بقا) به‌عنوان جایگزین.
