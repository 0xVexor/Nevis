# فهرست تصمیم‌ها

تاریخ: 2026-11-20 · ADRها در `docs/adr/` · برنامه در [ROADMAP.md](ROADMAP.md) · پرسش‌های مالک در [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)

## پاسخ به «فرمت داده‌ی ما JSON است؛ باید عوض شود؟» (جزئیات: ADR-0008)
1. **JSON می‌ماند** برای envelope سینک، رکوردها (فیلدهای موجودیت)، رویدادها، تنظیمات، API و export. استاندارد: **I-JSON (RFC 7493) روی RFC 8259**.
2. **بدنهٔ سند JSON نیست:** حالت و تغییرات صفحه **Yjs V1 دودویی** است. JSON ProseMirror فقط projection و قالب export است.
3. **پیوست‌ها** بایت خام‌اند با نام SHA-256؛ هرگز base64 در JSON ذخیره نمی‌شوند.
4. payload سینک بایت مات است (یک بایت نوع + JSON یا Yjs)، روی سیم base64url؛ برای رمزنگاری آینده و جلوگیری از base64 دوبل.
5. قواعد: UTF-8 بدون BOM؛ کلید تکراری = خطا؛ **هیچ float**، فقط عدد صحیح ±(2^53−1)؛ عدد اعشاری کاربر = رشته (`"12.50"`).
6. **شناسه‌ها (UUIDv7)، HLC و تاریخ‌ها همیشه رشته**؛ `null` در envelope و attrهای ProseMirror ممنوع، فقط در مقدار فیلد به معنای «خالی».
7. یونیکد: متن کاربر هرگز بازنویسی نمی‌شود؛ **ZWNJ همیشه حفظ**؛ NFC فقط برای برچسب‌ها و جست‌وجو.
8. **کانونیک‌سازی لازم نیست** (هیچ JSONی هش یا امضا نمی‌شود؛ idempotency روی بایت‌های ذخیره‌شده است). اگر روزی لازم شد: RFC 8785 (JCS)، نه قالب خودساخته.
9. export: ZIP با `manifest.json` + NDJSON (JSON Lines) + JSON ProseMirror + بایت خام؛ آینهٔ خوانا: CommonMark/GFM + YAML front-matter.
10. CBOR/MessagePack/Protobuf رد شدند: سود کم در برابر هزینهٔ دیباگ؛ بازبینی فقط با اندازه‌گیری M13.

## تصمیم‌ها
| # | تصمیم (خلاصه) | ADR | وضعیت | اطمینان | آزمونی که می‌تواند برگرداند |
|---|---|---|---|---|---|
| a | منبع حقیقت = پایگاه محلی هر دستگاه پشت یک رابط `Store`؛ IndexedDB در وب، SQLite (Rust) در دسکتاپ/موبایل؛ outbox/inbox جدا از اعمال | [0001](adr/0001-storage-model-and-source-of-truth.md) | تصمیم‌شده، منتظر spike | ۸۰٪ / ۶۵٪ (دسکتاپ) | M3 (Safari)، M5 (۱۰k)، M6 (IPC) |
| b | مدل داده: موجودیت = فیلدهای LWW + بدنهٔ اختیاری Yjs؛ UUIDv7 رشته‌ای برای همه؛ HLC رشتهٔ ثابت‌طول با deviceId؛ `v`/`sv`/`proto`/`minSv` جدا؛ سطل = `trashed`، حذف دائمی = purge | [0002](adr/0002-data-model-and-identity.md) | تصمیم‌شده | ۸۵٪ | خاصیت HLC در M2 |
| c | بدنه = Yjs 13 + `@tiptap/y-tiptap` پین دقیق؛ یک Y.Doc per موجودیت (`"body"`)؛ attr بدون null؛ `dir` و `blockId` با قواعد مشخص؛ V1؛ برابری = projection | [0003](adr/0003-document-body-yjs.md) | تصمیم‌شده، منتظر spike | ۷۰٪ | **M1** (IME، fuzz، اندازه) |
| d | دادهٔ ساختاریافته: رجیستر LWW per فیلد، مجموعه = رجیستر per عنصر، رویداد تغییرناپذیر؛ تسک = گره در بدنه؛ فلش‌کارت = fold روی مرورها | [0004](adr/0004-structured-data-conflict-rules.md) | تصمیم‌شده | ۸۰٪ | converge M2، M7 |
| e | پروتکل: لاگ append-only per workspace با `seq` سرور؛ push idempotent (۴۰۹ برای بایت متفاوت)؛ pull با cursor + long-poll؛ snapshot فقط شتاب‌دهنده در v1؛ `426` برای نسخه | [0005](adr/0005-sync-protocol.md) | تصمیم‌شده، منتظر spike | ۸۰٪ | **M2** (همگرایی، هم‌زمانی) |
| f | سرور Go تک‌باینری + SQLite (modernc، یک نویسنده)؛ کور نسبت به payload؛ کوکی HttpOnly برای وب، توکن دستگاه در keychain برای دسکتاپ؛ کپی auth/blob قدیمی | [0006](adr/0006-server-architecture.md) | تصمیم‌شده | ۸۰٪ | آزمون هم‌زمانی M2/M4 |
| g | منطق در هستهٔ TS بدون DOM؛ Rust فقط I/O؛ سینک پس‌زمینهٔ آینده = کوریر بی‌منطق | [0007](adr/0007-logic-placement-ts-core-and-rust.md) | تصمیم‌شده | ۷۵٪ | بنچ M5/M12 |
| h | سریال‌سازی و قالب‌ها per نوع داده (پاسخ JSON بالا) | [0008](adr/0008-serialization-and-file-formats.md) | تصمیم‌شده | ۸۵٪ | اندازه‌گیری M13 |
| i | باندل بدون اتلاف + آینهٔ یک‌طرفهٔ Markdown + import دادهٔ قدیمی روی یک دستگاه | [0009](adr/0009-export-import-and-ownership.md) | تصمیم‌شده | ۷۵٪ | round-trip M12 |
| j | نرمال‌سازی فارسی یک بار در TS (`NORM_VERSION`)؛ ZWNJ سه‌شکلی؛ یک ایندکس JS (MiniSearch) در همه‌جا | [0010](adr/0010-search-and-persian-normalization.md) | تصمیم‌شده، منتظر spike | ۸۰٪ / ۶۰٪ (موتور) | **M10** (بنچ ۱۰k) |
| k | آمادگی E2EE (`kid`، `n`، AAD الحاقی، compaction کلاینتی) و هم‌نویسی (`member` با نقش، workspace = واحد اشتراک، WebSocket فقط awareness) | [0011](adr/0011-encryption-and-collaboration-readiness.md) | تصمیم‌شده (آمادگی)؛ E2EE و هم‌نویسی: باز | ۷۵٪ | — |
| l | monorepo pnpm؛ Vitest + fast-check + Playwright؛ harness همگرایی و تزریق crash از M2؛ چک‌لیست دستگاه مالک | [0012](adr/0012-repo-tooling-and-testing.md) | تصمیم‌شده | ۸۵٪ | — |
| m | PWA + Tauri 2 دسکتاپ؛ موبایل: تصمیم در spike M16، گرایش Tauri، جایگزین Capacitor | [0013](adr/0013-shell-strategy.md) | وب/دسکتاپ تصمیم‌شده؛ موبایل باز | ۸۰٪ / ۵۰٪ | **M16** |

## تأیید یا رد برنامهٔ پیشین
برنامهٔ پیش از تحقیق (VISION «تصمیم‌های جهت‌دار») **تأیید شد** با این دقیق‌سازی‌ها: payload همیشه بایت مات (حتی رکوردها)؛ ارسال/دریافت جدا از اعمال (inbox)؛ snapshot در v1 بدون حذف op؛ «FTS5 دسکتاپ + JS وب» رد و یک موتور جست‌وجو؛ IndexedDB در WebView دسکتاپ رد؛ Yjs V1 به‌جای V2.

## باز (نیاز به مالک)
سینک پس‌زمینهٔ موبایل، E2EE در v1، زمان موبایل، مجوز، نام و … → [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).
