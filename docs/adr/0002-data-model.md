# ADR-0002 — مدل داده و ذخیره‌سازی محلی

- وضعیت: **پیشنهادی**
- تاریخ: 2026-10-24
- فایل‌ها: `db/migrations/0001_init.sql`، `db/normalize.mjs`، تست‌ها: `db/test-schema.mjs`، `db/test-crash.mjs`

## تصمیم‌ها

1. **هر صفحه یک ردیف است و محتوایش یک سند JSON (TipTap/ProseMirror) در ستون `content`.** بلاک‌ها ردیف جدا ندارند.
2. **SQLite در حالت WAL با `synchronous=FULL`** و `foreign_keys=ON`. نسخه schema با `PRAGMA user_version` و فایل‌های `migrations/NNNN_*.sql` که در یک تراکنش اجرا می‌شوند.
3. **شناسه‌ها UUIDv7** (TEXT، قابل‌تولید آفلاین روی هر دستگاه). زمان‌ها unix ms. حذف نرم با `deleted_at` (سطل زباله + tombstone برای Sync آینده).
4. **ترتیب هم‌نیاها با `sort_key` (fractional index)** تا جابه‌جایی صفحه فقط یک ردیف را تغییر دهد.
5. **جست‌وجو: FTS5 contentless** (`pages_fts`) با tokenizer استاندارد `unicode61`؛ **نرمال‌سازی فارسی در لایه برنامه** (`normalizeFa`) هم موقع index و هم موقع query: `ي/ك` عربی ← `ی/ک`، نیم‌فاصله ← فاصله، ارقام فارسی/عربی ← ASCII، حذف اعراب و کشیده. جست‌وجو prefix است.
6. **پیوست‌ها content-addressed** روی دیسک (`files/<sha[0:2]>/<sha256>`)؛ جدول `attachments` فقط متادیتا دارد و تکراری‌ها یکی ذخیره می‌شوند.
7. **backlinks از جدول مشتق `page_links`** که در هر ذخیره از روی content بازسازی می‌شود.
8. **`content_schema`** روی هر صفحه: وقتی schema ادیتور تغییر کند، migration محتوا نسخه‌دار است.

## چرا «سند JSON در هر صفحه»، نه «بلاک = ردیف»؟

- ذخیره و بازیابی یک صفحه atomic و ساده است؛ با auto-save هر چند ثانیه یک `UPDATE`.
- ادیتور ProseMirror خودش درخت بلاک را می‌شناسد؛ نگاشت بلاک↔ردیف SQL باگ و کندی می‌آورد (جدول و لیست تودرتو).
- برای Sync بعداً محتوای صفحه به **سند CRDT (مثلاً Yjs)** تبدیل می‌شود که به هر حال یک blob در هر صفحه است، نه ردیف‌های بلاک. پس بلاک=ردیف ارزشی برای sync نمی‌خرد.
- **هزینه:** query روی بلاک‌های خاص (مثلاً «همه checklistهای باز») بدون index جدا ممکن نیست. اگر لازم شد، جدول مشتق `tasks` را مثل `page_links` می‌سازیم. دیتابیس‌های Notion-مانند هم جدول جدا و مدل جدا خواهند داشت (خارج از MVP).

## نتایج تست (Node 24، SQLite 3.53.1)

`test-schema.mjs` (همه assert ها سبز):
- «كلاس» (ک عربی) صفحه «کلاس» را پیدا می‌کند؛ «برنامه نویسی» و «برنامه‌نویسی» هر دو؛ «۱۲۳» و «123»؛ prefix («وراث» ← «وراثت»)؛ انگلیسی case-insensitive؛ چندکلمه‌ای AND.
- درخت صفحات با recursive CTE، backlinks، حذف نرم از جست‌وجو، cascade هنگام حذف سخت، `integrity_check`.

`test-crash.mjs`: پروسه نویسنده وسط تراکنش بزرگ با `SIGKILL` کشته می‌شود؛ پس از باز کردن مجدد فقط داده commit‌شده مانده و `integrity_check = ok`.

## محدودیت‌ها و ریسک‌ها

- تست crash فقط kill پروسه است، نه قطع برق؛ قطع برق واقعی (fsync) با `synchronous=FULL` پوشش داده می‌شود ولی روی سخت‌افزار تست نشده.
- `fts_map` لازم شد چون جداول `WITHOUT ROWID` rowid ندارند؛ اگر ساده‌سازی خواستیم می‌توان `pages` را با rowid ساخت.
- ریسک: صفحه خیلی بزرگ (۱۵ هزار بلاک) هر ذخیره کل JSON را می‌نویسد (چند MB). با auto-save debounce قابل‌قبول است؛ اگر مشکل شد، تقسیم صفحه یا ذخیره افزایشی (CRDT updates).
- هنوز نیست: جدول tags، templates، دیتابیس‌ها، تنظیمات برنامه، رمزنگاری دیسک.

## نیاز بعدی (Tauri)

بعد از نصب Rust: دسترسی به SQLite از Rust با `rusqlite` یا `tauri-plugin-sql`، و همین فایل‌های migration بدون تغییر استفاده می‌شوند (FTS5 باید در build فعال باشد؛ `rusqlite` با feature `bundled` دارد).

## ضمیمه (2026-10-24): وضعیت پیاده‌سازی و تفاوت با `0001_init.sql`

اپ فعلی همین مدل را روی **IndexedDB** اجرا می‌کند (`spike/tiptap/src/db.ts`، `repo.ts`): store به نام `pages` (یک رکورد برای هر صفحه)، `versions` (تاریخچه) و `kv`. قرارداد `PageRepo` همان است که SQLite باید پیاده کند.

فیلدها و جدول‌هایی که از زمان نوشتن `0001_init.sql` اضافه شده‌اند و باید در **`0002_*.sql`** هنگام آمدن SQLite بیایند:

| تغییر | توضیح |
|---|---|
| `pages.kind` (`page` / `folder`) | پوشه فقط والد صفحه‌هاست و محتوا ندارد؛ از search/backlinks/export-md کنار گذاشته می‌شود |
| `pages.tags` (JSON یا جدول `page_tags`) | برچسب‌ها؛ در جست‌وجو و جدول صفحه‌ها استفاده می‌شوند |
| `pages.status` (`todo`/`doing`/`done`) | وضعیت |
| `pages.title_dir` (`rtl`/`ltr`/null) | جهت دستی عنوان |
| `pages.cover` (JSON) | کاور: گرادیان یا پیوست content-addressed |
| جدول `page_versions(page_id, ts, title, content)` | تاریخچه؛ حداکثر ۴۰ نسخه برای هر صفحه، حداکثر یکی در هر ۱۰ دقیقه؛ نسخه‌ی **قبل** از شروع هر دور ویرایش ذخیره می‌شود |
| `kv` (`srs`, `backupCfg`, `backupDir`) | زمان‌بندی فلش‌کارت‌ها و تنظیم پشتیبان؛ در SQLite می‌شود جدول `kv` یا `srs(card_key, ease, interval, reps, due)` |

نکات طراحی که حین پیاده‌سازی روشن شد:
- **نوشتن تک‌رکوردی:** هر `update` فقط رکورد همان صفحه را در یک تراکنش می‌نویسد؛ جابه‌جایی صفحه همه‌ی هم‌نیاها را (به‌خاطر `sort`) و حذف نرم همه‌ی زیرمجموعه را.
- **مهاجرت داده:** localStorage ← IndexedDB یک‌بار انجام می‌شود و کپی قدیمی فقط پس از خوانش‌مجدد موفق (هم‌تعداد) پاک می‌شود. همین الگو برای IndexedDB ← SQLite توصیه می‌شود.
- **شناسه‌ی کارت فلش‌کارت** = `pageId : hash(متن نرمال‌شده‌ی سؤال)`؛ با ویرایش بقیه‌ی صفحه عوض نمی‌شود، با تغییر متن سؤال کارت جدید حساب می‌شود.
- **مرجع تصویرها** برای پاک‌سازی: تصویر فقط وقتی حذف می‌شود که نه در محتوای هیچ صفحه (حتی سطل زباله) و نه در تنظیمات باشد و بیش از یک ساعت از افزودنش گذشته باشد.

## وضعیت (2026-10-24، بعدازظهر): schema کامل است، اتصال به برنامه مانده

- `db/migrations/0002_app_fields.sql` نوشته و در `test-schema.mjs` آزمون شد (`kind/status/title_dir/cover`، `page_tags`، `page_versions`، `srs`، `kv`). `user_version` پس از دو migration برابر ۲ است.
- **پیاده‌سازی شد (بررسی‌نشده روی ماشین بدون MSVC):** `spike/tiptap/src-tauri/src/main.rs` دستورهای `pages_save`، `kv_*`، `version_*`، `file_*` را روی همین migrationها دارد و `db.ts`/`attachments.ts` در Tauri از آن‌ها استفاده می‌کنند (در مرورگر همچنان IndexedDB). پیوست‌ها در `files/<sha[0:2]>/<sha>`. حذف صفحه، فرزندانش را به ریشه می‌برد (cascade نمی‌کند). `page_links` و FTS هنوز پر نمی‌شوند (جست‌وجو در JS است).
- **مانده:**
  1. Rust باید با target **MSVC** (`rustup default stable-x86_64-pc-windows-msvc`) + Visual Studio Build Tools (Desktop C++) + WebView2 باشد. نسخه‌ی نصب‌شده‌ی فعلی `gnullvm` است و برای Tauri در ویندوز مناسب نیست. برای macOS: Xcode Command Line Tools.
  2. دستورهای Rust (`rusqlite` با feature `bundled`): اجرای migrationها، و یک `PageRepo` معادل `repo.ts` که از `invoke` صدا زده می‌شود.
  3. مهاجرت یک‌باره IndexedDB ← SQLite با همان الگوی «خوانش مجدد هم‌تعداد، بعد پاک‌سازی».
  4. پیوست‌ها از IndexedDB به `files/<sha[0:2]>/<sha256>` روی دیسک؛ پشتیبان خودکار از File System Access به مسیر معمولی.
