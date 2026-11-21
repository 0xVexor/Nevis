# قالب باندل `*.nevis.zip` (نسخهٔ ۱)

باندل داده‌های شما را بدون اتلاف و در قالب باز نگه می‌دارد؛ بدون خود اپ هم خواندنی است (ZIP + JSON). حالت همکاری (Yjs، HLC) در آن نیست.

| فایل | محتوا |
|---|---|
| `manifest.json` | `{format:"nevis-bundle", formatVersion, sv, app, workspace:{id,name}, exportedAt, counts, missingAttachments, files:{نام: SHA-256}}` |
| `README.txt` | شرح فارسی/انگلیسی فایل‌ها |
| `entities.ndjson` | هر خط یک موجودیت: `{id, kind, createdAt, fields:{...}}` (حالت فعلی، بدون HLC)؛ کلیدها مرتب |
| `pages/<id>.json` | بدنهٔ صفحه، JSON ProseMirror با پیش‌فرض‌های پرشده (کلیدها مرتب) |
| `events/<kind>.ndjson` | رویدادهای تغییرناپذیر (`review`، `version`)؛ هر خط `{id, ent, kind, body}`، به ترتیب (hlc, id) |
| `attachments/<sha256>` | بایت خام پیوست (بدون فشرده‌سازی) |
| `attachments.ndjson` | `{hash, size, mime, name}` |

- **round-trip:** export ← import در workspace تازه ← export همان فایل‌ها را می‌دهد، به‌جز `exportedAt`، `workspace`، `app` (آزمون خودکار، `packages/bundle/test/bundle.test.ts`).
- **import:** همیشه در workspace **تازه**؛ هش هر فایل با manifest سنجیده می‌شود (باندل خراب رد می‌شود)؛ موجودیتی که از قبل هست → خطا، نه ادغام؛ برای هر صفحه Y.Doc تازه از JSON ساخته می‌شود؛ رویدادها با HLC تازه به ترتیب باندل نوشته می‌شوند (زمان‌بندی مرور از `reviewedAt` داخل رویداد می‌آید، پس بی‌اثر است).
- پیوستی که خوانده نشد (روی این دستگاه نیست و سرور در دسترس نبود) در `missingAttachments` نام برده می‌شود و هرگز با نام نادرست نوشته نمی‌شود.
- محدودیت: ZIP یک‌جا در حافظه ساخته می‌شود (نه استریم)؛ برای پیوست‌های بسیار بزرگ باید استریم شود (ADR-0009 §1).
