# ADR-0009: export/import و «یادداشت‌ها مال خود شماست»

- وضعیت: **تصمیم‌شده**
- اطمینان: ۷۵٪
- تاریخ: 2026-11-20
- مرتبط: ADR-0003، ADR-0008، ADR-0013؛ تحقیق: R6 §1-3، `storage-and-sync-options.md` §A-3 و §3-6

## زمینه
- کاربر باید هر وقت خواست همه‌چیز را در قالب باز و بدون اتلاف بردارد، و یک نسخهٔ خوانا برای ابزارهای دیگر داشته باشد.
- Markdown جهت هر بلوک، جدول ادغام‌شده، callout/toggle/ستون و شناسهٔ بلوک را نگه نمی‌دارد (R6 §1-ج)؛ ویرایش دوطرفهٔ فایل یعنی برگشت به heuristicهای قدیمی.
- `showDirectoryPicker` فقط در Chromium است (R6 §3).

## گزینه‌ها
| گزینه | نتیجه |
|---|---|
| Markdown دوطرفه (vault مثل Obsidian) | رد: منبع نوشتن دوم؛ اتلاف. |
| یک فایل SQLite به‌عنوان export | رد: خوانایی کم؛ وابسته به قالب داخلی. |
| **باندل بدون اتلاف (ZIP + JSON/NDJSON + بایت خام) + آینهٔ یک‌طرفهٔ Markdown + import Markdown بهترین‌تلاش** | **انتخاب.** |

## تصمیم
### ۱. باندل بدون اتلاف `*.nevis.zip`
```
manifest.json
README.txt                       فارسی + انگلیسی: هر فایل چیست
entities.ndjson                  یک خط per موجودیت: {"id","kind","createdAt","fields":{...}}  (حالت فعلی، بدون HLC)
pages/<id>.json                  JSON ProseMirror بدنه (projection با پیش‌فرض‌ها)
events/<kind>.ndjson             review، version (هر خط یک رویداد)
attachments/<sha256>             بایت خام
attachments.ndjson               {"hash","size","mime","name"}
```
```json
{"format":"nevis-bundle","formatVersion":1,"sv":1,"app":"0.1.0",
 "workspace":{"id":"019a…","name":"…"},"exportedAt":"2026-11-20T10:00:00.000Z",
 "counts":{"entities":120,"pages":80,"attachments":12},
 "files":{"entities.ndjson":"<sha256>","pages/019a….json":"<sha256>"}}
```
- ZIP با fflate به‌صورت استریم (R6 §2-ج)؛ پیوست‌ها بدون فشرده‌سازی (`ZipPassThrough`).
- حالت Yjs در باندل نیست: باندل «دادهٔ کاربر» است، نه «حالت همکاری».
- **round-trip:** export → import در workspace تازه → export باید فایل‌های یکسان بدهد (به‌جز `exportedAt`، `workspace` و `app`). آزمون خودکار اجباری.

### ۲. import
- **import باندل:** همیشه در **workspace تازه**؛ شناسه‌های موجودیت حفظ می‌شوند؛ برای هر صفحه Y.Doc تازه از JSON ساخته می‌شود (مجاز چون سند جای دیگری در این workspace وجود ندارد؛ ADR-0003 بند ۷). اگر شناسه‌ای از قبل در workspace مقصد هست → خطا، نه ادغام.
- **import یک‌بارهٔ دادهٔ اپ قدیمی (فقط دادهٔ مالک):** ابزار `pnpm nevis import-legacy <vaultDir>` که vault قدیمی (JSON صفحه‌ها، پایگاه‌داده‌ها، kv، پیوست‌ها) را به باندل `formatVersion:1` تبدیل می‌کند؛ بعد import باندل. **روی یک دستگاه** اجرا می‌شود. نگاشت دقیق در M12 بعد از خواندن قالب قدیمی نوشته می‌شود.
- **import Markdown/Obsidian:** بهترین‌تلاش، فقط ساخت صفحهٔ تازه؛ بعد از v1.

### ۳. آینهٔ یک‌طرفهٔ Markdown (فقط دسکتاپ)
- کاربر یک پوشه انتخاب می‌کند؛ اپ بعد از هر تغییر (debounce ۵ ثانیه) فایل صفحه‌های تغییرکرده را بازنویسی می‌کند. **هرگز از پوشه نمی‌خواند.**
- نام فایل: `<slug عنوان>--<۸ کاراکتر آخر id>.md`؛ ساختار پوشه = درخت صفحه‌ها. تغییر عنوان = rename فایل.
- front-matter: `id`، `title`، `parent`، `tags`، `created`، `updated`، `dir`. خط اول بدنه یک کامنت HTML: «این فایل خودکار ساخته می‌شود؛ تغییرات شما بازنویسی می‌شود».
- نگاشت بلوک: GFM برای عنوان/فهرست/کد/جدول ساده/تسک؛ `$…$` و `$$…$$` ریاضی؛ mermaid در fenced block؛ callout = `> [!note]`؛ toggle = `<details>`؛ بلوکی که `dir` آن با جهت صفحه فرق دارد = `<div dir="rtl">…</div>`؛ جدول پیچیده = HTML؛ نقاشی = پیوست تصویر؛ ستون‌ها = `<div class="nv-columns">`؛ شناسهٔ بلوک `^<blockId>` فقط وقتی بلوک ارجاع دارد. پایگاه‌داده = `<name>.csv`.
- نوشتن اتمی (temp + rename) با Rust؛ صفحهٔ trashed → حذف فایل.
- **وب:** دکمهٔ «دانلود Markdown (zip)» با همان مبدل؛ آینهٔ زنده در وب نه.
- مبدل Markdown در `packages/core` (یک پیاده‌سازی) و با fixtureهای golden آزموده می‌شود.

### ۴. «مال شما»
- سه راه خروج: باندل (کامل)، آینه/zip Markdown (خوانا)، بکاپ سرور (مدیر سرور).
- قالب باندل در `docs/formats/bundle-v1.md` (در M12) مستند می‌شود تا بدون اپ خواندنی باشد.

## پیامدها
- ویرایش بیرونی فایل‌های آینه پشتیبانی نمی‌شود؛ این باید در UI صریح باشد.
- اتلاف Markdown مستند می‌شود (جدول اتلاف در README باندل).

## چه چیزی تصمیم را برمی‌گرداند
- اگر مالک ویرایش دوطرفهٔ Markdown را ضروری بداند: فقط به‌صورت «import تغییرات به‌عنوان ویرایش Yjs با diff متن» و در milestone جدا؛ ریسک بالا (OPEN-QUESTIONS).
