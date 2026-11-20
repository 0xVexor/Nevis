# Nevis: گزینه‌های ذخیره‌سازی و سینک (گزارش تصمیم)

تاریخ: 2026-11-20 · وضعیت: پیشنهاد برای ADR (هیچ کدی در مخزن تغییر نکرده است)
دامنه: فرمت داده، مدل سینک، محل منطق، نقش سرور، جست‌وجو/تاریخچه/پیوست، فهرست «پیش از انتشار».

## راهنمای برچسب‌ها (هر ادعای غیرواضح یکی از این‌ها را دارد)

| برچسب | معنی |
|---|---|
| **[کد]** | با خواندن کد یا ADRهای همین مخزن تأیید شد |
| **[مستند]** | صفحه‌ی مستندات/منبع اصلی در همین جلسه واکشی و خوانده شد |
| **[ثانویه]** | فقط از خلاصه‌ی جست‌وجو، آینه‌ی مستندات (Mintlify/DeepWiki)، وبلاگ یا انجمن؛ قابل اتکا برای جهت، نه برای جزئیات |
| **[حافظه]** | دانش پیشین من، در این جلسه دوباره تأیید نشد |
| **[استنباط]** | نتیجه‌گیری خودم از شواهد بالا |

محدودیت‌های این پژوهش که باید صادقانه گفته شود: ابزار واکشی بعضی صفحات را نگرفت (sqlite.org/wasm با ۵۰۳؛ مقاله‌ی Notion ریدایرکت شد)؛ **هیچ چیز روی Safari/iOS واقعی اجرا نشد**؛ هیچ benchmark تازه‌ای اجرا نشد؛ برای محصولاتی مثل Bear، Apple Notes، Craft، Capacities، Tana و Trilium و داخل Obsidian Sync منبع اصلی خوانده نشد و فقط در یک ردیف «تأییدنشده» آمده‌اند.

---

# ۱) خلاصه‌ی اجرایی (یک صفحه)

## تصمیم‌ها

| محور | پیشنهاد | اطمینان |
|---|---|---|
| **A. فرمت** | **منبع حقیقت = یک پایگاه محلی per-workspace (SQLite روی دسکتاپ، IndexedDB روی وب) که حالت CRDT صفحه‌ها و رجیسترهای ساختاریافته را نگه می‌دارد؛ روی سیم = لاگ append-only از envelopeهای مات.** فایل‌ها **بستر سینک نیستند.** مالکیت داده با سه چیز تأمین می‌شود: (۱) bundle بدون اتلاف (`.nevisbundle` = zip با JSON ProseMirror + پیوست‌ها)، (۲) آینه‌ی یک‌طرفه‌ی Markdown+YAML در پوشه‌ی دلخواه کاربر، (۳) بکاپ کامل سرور. | **۸۰٪** (سمت «فایل بستر سینک نباشد»؛ ۶۵٪ روی جزئیات فرمت) |
| **B. مدل سینک** | **هیبرید:** Yjs (نسخه‌ی ۱۳، پین‌شده) برای بدنه‌ی صفحه‌ها، همراه با رجیستر LWW سطح‌فیلد با Hybrid Logical Clock برای داده‌ی ساختاریافته (ردیف‌های دیتابیس، متادیتای صفحه، تنظیمات)، و لاگ رویداد immutable برای مرور فلش‌کارت و نسخه‌های تاریخچه. یک لاگ per-workspace با `seq` سروری. فشرده‌سازی (compaction) **توسط کلاینت.** | **۷۵٪** |
| **C. محل منطق** | **هسته‌ی TypeScript** (Yjs، HLC، موتور سینک، نرمال‌سازی فارسی، استخراج لینک/متن) که روی وب، دسکتاپ (WebView) و Node (تست) اجرا می‌شود؛ Rust فقط **I/O سیستم‌عامل** (فایل، SQLite، keychain، FTS5، loopback MCP، قفل). این **بخشی از ADR-0007 را برمی‌گرداند** (crate `nevis-core` + `nevis-wasm`). | **۷۰٪** |
| **D. نقش سرور** | سرور Go «کور» می‌ماند: لاگ append-only با `seq`، batch idempotent با id سمت کلاینت، blobها با هش، snapshotهای کلاینت‌ساز، long-poll/SSE، احراز هویت و اعمال حداقل نسخه‌ی پروتکل/schema. **هرگز payload را تفسیر نمی‌کند.** E2EE در v1 ساخته نمی‌شود ولی envelope با `kid` و payload مات از روز اول. | **۸۰٪** (کور ماندن)، **۵۰٪** (اینکه E2EE هرگز لازم نشود) |
| **E. جست‌وجو/تاریخچه/پیوست** | نرمال‌سازی فارسی یک بار در TS؛ ایندکس مشتق و غیرسینک (FTS5 روی دسکتاپ، ایندکس JS روی وب تا اثبات SQLite-WASM)؛ backlinkها جدول مشتق؛ تاریخچه = رویدادهای snapshot immutable با thinning، نه Yjs-snapshot؛ GC پیوست‌ها با «مجموعه‌ی ارجاع» توسط کلاینت و دوره‌ی مهلت. | **۶۵٪** |

## چرا (در پنج جمله)
1. مشکلات فعلی (heuristic حذف، resurrection، clamp ساعت، دوبار نوشتن موتور) همه از یک ریشه می‌آیند: **سینک روی فایل با md5 معنایی ندارد**؛ باید روی عملیات علّی/رجیستر بنشیند. **[کد: ADR-0004 بخش‌های hold_deletes و tombstone]**
2. Yjs تنها گزینه‌ای است که هم‌زمان (الف) روی TipTap بالغ و در همین مخزن آزموده است (`yjs-compat`، **[کد: ADR-0007]**)، (ب) در Safari بدون WASM-ضروری اجرا می‌شود، (ج) سرور ساده‌ی Go بدون درک محتوا می‌تواند لاگ آن را ذخیره کند.
3. موتورهای SQL-sync (PowerSync، Zero، Electric) به Postgres/Mongo نیاز دارند و با سرور Go+SQLite ناسازگارند؛ cr-sqlite نگه‌داری نامطمئن دارد. **[مستند/ثانویه، جزئیات در §۳-B]**
4. دلیل اصلی Rust-core در ADR-0007 «ادغام بایت‌به‌بایت یکسان» بود که از **مقایسه‌ی md5 فایل** می‌آید. با CRDT+LWW، همگرایی با ساختار تضمین می‌شود و دلیل از بین می‌رود. MCP هم همین حالا در WebView اجرا می‌شود. **[کد: `mcp.rs` خط ۱: «Document behavior stays in the webview TypeScript service»؛ استنباط برای بقیه]**
5. فایل Markdown **نمی‌تواند** جهت per-block، سلول‌های ادغام‌شده، callout/toggle/ستون و شناسه‌ی بلاک را بدون افزونه‌های ناسازگار نگه دارد؛ پس بهترین استفاده از آن «خروجی خوانا» است نه «منبع حقیقت».

## چیزی که باید قبل از هر کد دیگر اثبات شود
اسپایک ۳ تا ۵ روزه (بخش ۴): ادیتور واقعی TipTap + `@tiptap/y-tiptap` با فارسی/IME/جهت per-block، لاگ روی سرور Go، هم‌گرایی fuzz، و **اجرای واقعی روی Safari و iPhone** (در این محیط ممکن نبود).

---

# ۲) مقایسه‌ها به‌تفکیک سؤال

## A. فرمت فایل/داده

### A-۱. فرمت‌های کاندید برای متن غنی

| فرمت | جهت per-block | جدول (سلول بلاک‌دار، merge) | callout/toggle/ستون | شناسه‌ی بلاک | ادغام هم‌زمان | خوانایی انسانی | حکم |
|---|---|---|---|---|---|---|---|
| Markdown + YAML front-matter | ندارد (فقط HTML درون‌خطی `<div dir>`؛ Obsidian آن را نمی‌فهمد) **[استنباط]** | GFM: بدون سلول ادغامی و بدون بلاک در سلول **[حافظه]** | callout: قرارداد Obsidian `> [!note]` غیراستاندارد؛ toggle فقط `<details>`؛ ستون: ندارد **[حافظه]** | `^id` قرارداد Obsidian، بدون تضمین یکتایی | ندارد (فقط diff متنی) | بسیار بالا | **فقط export/mirror** |
| ProseMirror JSON | دارد (attr `dir`، [کد: ADR-0001]) | کامل | کامل (schema خودمان) | attr | ندارد (ساختار درختی؛ merge فعلی ما `blockmerge.rs` ۳۸۱ خط heuristic است **[کد]**) | متوسط | **قالب export بدون اتلاف و ورودی فهرست/جست‌وجو؛ نه ذخیره‌ی اصلی** |
| Yjs update (binary) | دارد (attr روی `Y.XmlElement`، LWW در هر attr **[حافظه]**) | کامل | کامل | attr | **بله، درون بلوک و ساختاری** | ندارد | **بدنه‌ی صفحه** |
| Automerge 3 | از طریق `@automerge/prosemirror` 0.2.0 | | | | بله | ندارد | رد (بلوغ binding، §B) |
| Loro | از طریق `loro-prosemirror` ~0.4.x | | | | بله؛ Tree/MovableList بومی | ندارد | رد/نظارت (§B) |
| یک فایل SQLite به‌عنوان *بستر سینک* | — | — | — | — | — | ندارد | رد: ADR-0003 خودش نشان داده فایل SQLite در WAL با درایو/سینک فایل خراب/conflicted می‌شود **[کد: ADR-0003 «زمینه»]** |
| SQLite به‌عنوان *ظرف محلی* | — | — | — | — | — | با ابزار | **بله، محلی و غیرسینک** |
| zip/bundle | — | — | — | — | — | متوسط | **فقط export/backup** |

**منابع:** Loro 1.0 (stable encoding، shallow snapshot، Fugue، rich text) [ثانویه]: https://www.loro.dev/changelog/v1.0.0-beta ، https://loro.dev/blog/v1.0 ؛ README: https://github.com/loro-dev/loro [مستند: «Loro 1.0 is out», Rich Text, Tree, Movable List، ذکری از ProseMirror ندارد]. `loro-prosemirror` 0.2.x/0.4.x، ~125 star: [ثانویه] https://github.com/loro-dev . Automerge 3.0 (کاهش حافظه ۱۰×؛ فرمت فایل همان v2): https://automerge.org/blog/automerge-3/ [ثانویه، از خلاصه‌ی جست‌وجو]؛ `@automerge/prosemirror` 0.2.0: https://cdn.jsdelivr.net/npm/@automerge/prosemirror@0.2.0/README.md [ثانویه].

### A-۲. محصولات واقعی: چه چیزی محلی نگه می‌دارند، چه چیزی سینک می‌شود، و چرا کار می‌کند یا آزار می‌دهد

| محصول | ذخیره‌ی محلی / سینک | چرا کار می‌کند یا نمی‌کند | برچسب و منبع |
|---|---|---|---|
| **Logseq** | نسخه‌ی OG: فایل md/org؛ نسخه‌ی DB: یک فایل SQLite منبع حقیقت؛ نسخه‌ی DB هنوز beta (انتشار بتا ۲۰۲۶-۰۷-۱۳ طبق یک منبع ثانویه)، با هشدار مستقیم repo درباره‌ی احتمال از دست رفتن داده؛ مهاجرت فایل→DB ابزار ناقص | **جهش خود Logseq از فایل به DB شاهد است که فایل به‌عنوان بستر برای بلاک/ویژگی/کوئری/RTC کافی نبود.** هزینه: چندین سال بتا و تقسیم کاربران | [ثانویه] https://github.com/logseq/logseq/ ، https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020 ؛ استنباط درباره‌ی «چرا» [استنباط] |
| **SiYuan** | هر سند یک `.sy` (JSON درخت بلاک)، SQLite فقط ایندکس مشتق؛ سینک snapshot-based با S3/WebDAV (E2EE)؛ **دیسک سینک شخص‌ثالث رسماً پشتیبانی نمی‌شود چون ممکن است داده خراب شود** | دقیقاً مدل فعلی ما (فایل JSON per page) و دقیقاً همان ترس ADR-0003 | [ثانویه] https://github.com/siyuan-note/siyuan (خلاصه‌ی جست‌وجو) |
| **Joplin** | هر آیتم (note, notebook, tag, resource) یک فایل روی sync target؛ `info.json` با `appMinVersion`؛ E2EE اختیاری؛ همگام‌سازی برنامه‌ی کلاینت با polling | **ساده و قابل‌اتکا چون هر آیتم فایل است و سرور فقط ذخیره‌گاه است؛ بهایش: بدون merge درون‌متنی** (تداخل → کپی تداخلی [حافظه]). الگوی `appMinVersion` را بگیریم | [مستند] https://joplinapp.org/help/dev/spec/sync/ |
| **Standard Notes** | آیتم‌های رمز‌شده، هر آیتم کلید تصادفی خودش؛ سرور «dumb data-store»؛ حتی کلیدها آیتم‌اند | الگوی مرجع E2EE: سرور نه جست‌وجو می‌کند نه ادغام؛ تمام جست‌وجو سمت کلاینت | [مستند] https://standardnotes.com/help/security/encryption |
| **Anytype** | آبجکت‌ها DAG رمزشده با تغییرات امضاشده؛ تفکیک تداخل روی دستگاه؛ self-host با any-sync-bundle نیازمند MongoDB و Redis (طبق راهنمای غیررسمی)؛ سایت رسمی self-host را «به‌زودی» برای بیزینس می‌گوید | E2EE واقعی ممکن است ولی **زیرساخت سمت سرور سنگین و پروتکل اختصاصی**؛ ما سرور Go+SQLite ساده می‌خواهیم | [ثانویه] https://pkg.go.dev/github.com/anyproto/any-sync ، https://doc.anytype.io/anytype/data/privacy-and-encryption ، https://codeberg.org/Safecast/AnyType-VPS |
| **AFFiNE** | Yjs doc؛ سرور: جدول snapshot + جدول updateها، فشرده‌سازی (merge چند update به snapshot) سمت سرور (native runtime)؛ Postgres؛ بلاب جدا | **تأیید می‌کند الگوی «Yjs + لاگ update + snapshot» در محصول واقعی کار می‌کند؛** بهایش: سرور باید Yjs بفهمد (compaction) → با E2EE ناسازگار؛ ما این را به کلاینت می‌دهیم | [ثانویه، آینه‌ی Mintlify/DeepWiki؛ کد منبع خوانده نشد] https://deepwiki.com/toeverything/AFFiNE/4.2-document-processing-and-y-octo-crdt |
| **AppFlowy** | cloud self-host شامل Postgres + Redis + Minio + GoTrue؛ داخل سند از CRDT (Yrs) استفاده می‌کند | سرور خودمیزبان سنگین‌تر از هدف ما. جزئیات CRDT را در این جلسه نخواندم | cloud: [مستند] https://docs.appflowy.io/docs/documentation/appflowy-cloud/architecture ؛ Yrs: [حافظه] |
| **Notion** | داخل: رکورد بلاک در Postgres سمت سرور؛ کلاینت‌ها cache محلی SQLite (WASM در وب)؛ export = Markdown/CSV/HTML با اتلاف | الگوی «سرور مرجع + cache محلی» با نیاز آنلاین؛ مستقیماً قابل‌کپی برای ما نیست (ما offline-first و self-host هستیم) | [حافظه] ؛ مقاله‌ی Notion «WASM SQLite» واکشی نشد |
| **Obsidian** | فایل md روی دیسک؛ Obsidian Sync اختصاصی (E2EE اختیاری)؛ سینک شخص‌ثالث با iCloud/Syncthing و تداخل متنی | بزرگ‌ترین مزیتش «فایل‌های خودتان»؛ بهایش: نه جهت per-block، نه ساختار بلاک؛ ادغام فقط diff-match روی متن **[حافظه]** | [حافظه] |
| **Bear، Apple Notes (CloudKit)، Craft، Capacities، Tana، Trilium** | — | **تأییدنشده؛ منبع اصلی خوانده نشد؛ عمداً توصیف نشدند تا مطلب غلط وارد گزارش نشود.** (برای ADR، اگر لازم است، Trilium را مستقیماً از مستندات بخوانید چون SQLite محلی + سینک موجودیت است؛ این فقط یادآوری است، نه ادعا.) | تأییدنشده |

**نتیجه‌ی A-۲ [استنباط]:** محصولاتی که به «فایل = منبع حقیقت و سینک» تکیه دارند (Obsidian، Logseq OG، SiYuan، Joplin) یا ادغام درون‌متنی ندارند، یا (Logseq) خودشان از آن دور شدند، یا (SiYuan) صراحتاً اخطار خراب شدن می‌دهند. محصولاتی که ادغام بلادرنگ دارند (AFFiNE، AppFlowy، Anytype) همه **حالت CRDT/DAG را ذخیره می‌کنند و Markdown را فقط export می‌کنند.**

### A-۳. «داده‌ی کاربر مال خود اوست» چقدر مهم است و ارزان‌ترین طراحی چیست؟

- **اهمیت [استنباط]:** برای مخاطب شما (فارسی‌زبان، self-host، نگران وابستگی به سرویس) *خروج‌پذیری* مهم است: «هر وقت خواستم همه‌ی چیز را در قالب استاندارد بردارم». ولی *قابل ویرایش بودن با ابزار دیگر* روی همان فایل‌ها لازم نیست و هزینه‌اش بالاست: هر ویرایشگر بیرونی یعنی منبع نوشتن دوم، یعنی دقیقاً heuristicهای فعلی (resurrection، held delete).
- **طراحی ارزان:**
  1. **`.nevisbundle`** (zip): `manifest.json` + `pages/*.json` (ProseMirror JSON کامل) + `databases/*.json` + `attachments/<hash>` + `history/`. بدون اتلاف و با schema نسخه‌دار. همین قالب «بکاپ» و «انتقال» است.
  2. **آینه‌ی یک‌طرفه‌ی Markdown**: یک job پس‌زمینه در دسکتاپ (Rust: فقط نوشتن فایل) که از روی JSON، Markdown+front-matter را در پوشه‌ی انتخابی بنویسد؛ فقط اگر hash محتوا عوض شده باشد. **هیچ بازخوانی خودکار نیست.** (اگر کسی فایل را ویرایش کند، ویرایش دور ریخته می‌شود و بالای فایل یک کامنت می‌گوید «خروجی خودکار است».)
  3. **import از Markdown** به‌عنوان ورودی دستی و best-effort (ایجاد صفحه‌ی جدید، نه merge).
  4. **API/MCP** به‌عنوان «رابط ماشین‌خوان» برای ابزارها و AI (از قبل وجود دارد [کد]).
- **بهای فایل‌به‌عنوان‌بستر (شاهد خودمان):** ۵ قاعده‌ی hold در ADR-0004 (انبوه، همه‌ی فایل‌ها، یک‌طرف‌خالی، نبود تأییدنشده، نسخه‌ی قدیمی برگشته) **[کد]**؛ هر کدام جبران نبود علّیت.

## B. مدل سینک

### B-۱. جدول مقایسه برای نیازهای دقیق ما

نیازها: offline-first، متن غنی هم‌زمان، سلول جدول، حذف، تاریخچه/undo، پیوست، جست‌وجو، وب (Safari/iOS)، سرور ساده‌ی Go + SQLite.

| گزینه | وضعیت (تاریخ) | self-host ساده روی Go+SQLite؟ | متن غنی ProseMirror | داده‌ی ساختاریافته | Safari/وب | حکم |
|---|---|---|---|---|---|---|
| **Yjs/yrs** (+`@tiptap/y-tiptap`) | Yjs 13 پایدار؛ **Yjs 14 (`@y/y`) هنوز rc** و `@y/prosemirror` v2 در حال بازنویسی؛ BlockNote PR پشتیبانی v14 هنوز پیش‌نویس (مه ۲۰۲۶). `@tiptap/y-tiptap` 3.0.2 (ژانویه ۲۰۲۶) روی Yjs 13 است [ثانویه: https://fosdem.org/schedule/event/8VKQXR-blocknote-yjs-prosemirror ، https://socket.dev/npm/package/@tiptap/y-tiptap ، https://github.com/TypeCellOS/BlockNote/pull/2739] | بله: سرور فقط بایت‌ها را در لاگ نگه می‌دارد؛ compaction با کلاینت | **بالغ‌ترین**؛ سازگاری yrs↔yjs↔y-tiptap در همین مخزن آزموده شده [کد: ADR-0007، `scripts/yjs-compat.sh`] | ضعیف (باید خودمان رجیستر بسازیم) | JS خالص | **انتخاب برای بدنه** |
| **Loro** | 1.0 از اکتبر ۲۰۲۴؛ نسخه‌های ۱.۱x در ۲۰۲۶ [ثانویه: changelog unpkg 1.14/1.16]؛ `loro-prosemirror` 0.x با ~۱۲۵ star | بله (بایت مات) | کمتر آزموده؛ بازنویسی binding به‌جای Collab TipTap؛ در این جلسه با TipTap تست نشد | Tree/MovableList بومی (برای جابه‌جایی بلاک مفید) | WASM لازم | **رد فعلاً؛ ارزیابی دوباره پس از اثبات binding.** مزیت واقعی: move و shallow snapshot |
| **Automerge 3** | 3.0 (حافظه ۱۰× کمتر) [ثانویه: https://automerge.org/blog/automerge-3/]؛ `@automerge/prosemirror` 0.2.0 | بله | binding نابالغ‌تر | سند JSON-مانند خوب | WASM | رد |
| **cr-sqlite** (vlcn) | repo آرشیو نشده؛ آخرین push در متادیتای موجود اکتبر ۲۰۲۴ [ثانویه]؛ README: «v2 خواهد آمد»، «counter و rich-text CRDT هنوز پیاده نشده»؛ خلاصه‌ی GitHub: 2168 commit، بدون release [مستند: https://github.com/vlcn-io/cr-sqlite] | بله (extension)، ولی ریسک پروژه | متن غنی ندارد | row/column LWW | WASM+OPFS | **رد** (نگه‌داری نامطمئن) |
| **PowerSync** | Open Edition؛ جدول وضعیت: GA (docs)، منبع: Postgres/MongoDB/MySQL/SQL Server...؛ نیاز logical replication؛ bucket storage در Mongo/Postgres [ثانویه: https://docs.powersync.com/resources/feature-status.md ، https://www.powersync.com/blog/powersync-open-edition-release] | **خیر: به Postgres/Mongo نیاز دارد** | متن غنی ندارد | عالی (SQLite کلاینت) | از OPFS VFS خودشان استفاده می‌کند | رد برای ما؛ مرجع خوب برای OPFS |
| **ElectricSQL** | 1.0 مارس ۲۰۲۵؛ «read-path sync از Postgres»؛ نوشتن با خود شماست [ثانویه: https://electric-sql.com/blog/2025/03/17/electricsql-1.0-released] | خیر (Postgres) | ندارد | read-only sync | | رد |
| **Zero (Rocicorp)** | 1.0 در ژوئن ۲۰۲۶ [ثانویه: https://infoq.com/news/2026/06/zero-version-1]؛ self-host: zero-cache + Postgres با logical WAL [ثانویه: https://zero.rocicorp.dev/docs/self-host (فقط از خلاصه‌ی جست‌وجو)] | خیر | ندارد | عالی (کوئری‌محور) | | رد |
| **Replicache** | maintenance mode؛ توسعه به Zero رفته [ثانویه: https://forums.basehub.com/rocicorp/mono/1] | نیاز به بک‌اند خودتان | ندارد | خوب | | رد (خاتمه‌ی عمر) |
| **Triplit** | مت لینکوس (هم‌بنیان‌گذار) به Supabase پیوست (۸ اکتبر ۲۰۲۵)؛ **خود Supabase آن را «hire» می‌نامد نه خرید محصول؛ PitchBook آن را acquisition می‌نامد؛ آینده‌ی OSS نامشخص** [ثانویه: https://supabase.com/blog/triplit-joins-supabase] | | ندارد | خوب | | رد (ریسک آینده) |
| **Jazz / Evolu / LiveStore** | فقط خلاصه‌ی سطحی جست‌وجو: Jazz = DB رابطه‌ای local-first با sync و self-host ممکن؛ Evolu = SQLite + E2EE sync با سرور relay؛ LiveStore = event-sourced SQLite [ثانویه: https://electric-sql.com/docs/reference/alternatives ، https://smashingmagazine.com/2026/05/architecture-local-first-web-development/] | تأییدنشده | هیچ‌کدام متن غنی ProseMirror را بومی حل نکرده‌اند (تأییدنشده) | بله | | **ارزیابی عمیق انجام نشد؛ رد به‌خاطر «framework lock-in + ناشناخته بودن»، نه به‌خاطر نقص ثابت‌شده.** ادعای من: LiveStore/Evolu الگوی رویدادمحور را نشان می‌دهند که ما به‌صورت سبک خودمان می‌سازیم **[استنباط]** |
| **فایل+md5 فعلی** | کار می‌کند ولی دو موتور، heuristicهای زیاد [کد] | بله | `blockmerge.rs` heuristic | `db_merge.rs` سلولی | | **رد (جایگزین شود)** |

### B-۲. هیبرید پیشنهادی (Yjs + رجیستر LWW با HLC)

- **بدنه‌ی صفحه** = یک `Y.Doc` per page (`XmlFragment` «content»)، اتصال با `@tiptap/y-tiptap` (تصمیم A در ADR-0007، اینجا تأیید می‌شود).
- **متادیتای صفحه** (عنوان، parent، `sortKey`، آیکون، تگ‌ها، `trashedAt`) = رجیسترهای LWW سطح‌فیلد با HLC (عنوان بیرون از Y.Doc تا لیست صفحات بدون بارگذاری Y.Doc ساخته شود).
- **دیتابیس‌ها:** تعریف property/view = رجیستر LWW؛ ردیف = موجودیت با سلول‌های LWW؛ multi-select/relation = مجموعه‌ی add-wins سطح‌عنصر (جلوگیری از اینکه دو افزودن هم‌زمان یکدیگر را پاک کنند)؛ بدنه‌ی صفحه‌ی ردیف = همان بدنه‌ی صفحه (`rowId == pageId`).
- **فلش‌کارت:** کارت = رجیستر؛ **مرور = رویداد immutable**؛ زمان‌بندی (FSRS/SM) = fold قطعی روی رویدادها به ترتیب HLC (cache محلی، قابل بازسازی). این `merge_kv` فعلی (۴۳ خط، [کد]) را حذف می‌کند.
- **تنظیمات هم‌گام:** نقشه‌ی LWW. تنظیم per-device هرگز سینک نمی‌شود.
- **حذف:** `deleted` یک رجیستر LWW است (حذف صفحه/ردیف)؛ فیلدها همچنان ثبت می‌شوند. «بازگردانی» = نوشتن `deleted=false` با HLC جدیدتر. **بدون «نبودن = حذف».**

### B-۳. گوتچاهای Yjs که باید در طراحی بیایند

| گوتچا | توضیح | برچسب |
|---|---|---|
| **GC روشن بماند** | `gc:false` برای snapshot نسخه‌ها رشد بی‌حد می‌آورد؛ LegendKeeper برای نسخه‌ها GC را خاموش کرد و گفت بعضی سندها خیلی بزرگ شدند؛ UndoManager هم GC را بی‌اثر می‌کند و رشد سند را گزارش داده‌اند | [ثانویه] https://legendkeeper.com/changelog/legendkeeper-0-13-5-1 ، https://discuss.yjs.dev/t/undo-manager-disables-gc-makes-doc-size-grow-unbounded/3797 |
| **`mergeUpdates` خودش GC نمی‌کند** | GC فقط هنگام `applyUpdate` روی `Y.Doc` با gc=true | [ثانویه] https://discuss.yjs.dev/t/handling-slow-mergeupdates-on-server/1105/3 |
| **تاریخچه با Yjs snapshot گران است** | پس تاریخچه را با snapshot مستقل بسازید (E-۳) | [استنباط از دو مورد بالا] |
| **Yjs `move` ندارد** | جابه‌جایی بلاک = حذف+درج؛ ویرایش هم‌زمان روی بلاک جابه‌جاشده می‌تواند گم شود یا تکراری شود؛ Loro این را بومی دارد | [حافظه] |
| **clientID** | هر `Y.Doc` یک clientID تصادفی؛ **استفاده‌ی مجدد یک clientID در دو تب/نمونه، خرابی می‌آورد** → در وب با چند تب باید هر نمونه clientID جدا بگیرد یا یک «leader tab» ویرایش را نگه دارد؛ state vector با تعداد نشست‌ها بزرگ می‌شود (compaction کوچکش می‌کند) | [حافظه] |
| **schema ناشناخته** | اگر update‌ی نسخه‌ی جدید node/attr ناشناخته بیاورد، y-prosemirror ممکن است خطا بدهد یا محتوا را بیندازد → **قاعده:** کلاینت هر op با `sv` بزرگ‌تر از schema خود را اعمال نمی‌کند و به حالت «نیاز به به‌روزرسانی» می‌رود | [استنباط] |
| **Yjs 14** | پیش‌انتشار؛ API نگاشت attribution/versioning جدید؛ مهاجرت از ۱۳ به ۱۴ بخشی از ریسک آینده است | [ثانویه] لینک‌های بالا |
| **بزرگی** | صفحه‌ی ۱۵ هزار بلاک: بارگذاری کامل `Y.Doc` و ساخت view سنگین؛ ADR-0002 هم این را ریسک می‌داند | [کد: ADR-0002 «محدودیت‌ها»] |
| **سازگاری yrs↔yjs** | تأیید شده (صفحه‌ی ساخته‌شده با yrs را yjs و y-tiptap می‌خوانند؛ ویرایش هم‌زمان ادغام می‌شود)؛ **آزمون fuzz عمیق و عملکرد روی صفحه‌ی بزرگ هنوز ندارد** | [کد: ADR-0004، ADR-0007] |

### B-۴. فهرست ردشده‌ها و دلیل (خلاصه)

| رد | دلیل اصلی |
|---|---|
| ادامه‌ی فایل+md5 | ریشه‌ی heuristicها؛ دو موتور؛ [کد] |
| PowerSync / Zero / Electric | Postgres یا Mongo لازم، با «سرور Go+SQLite ساده» نمی‌خواند |
| Replicache | maintenance mode |
| cr-sqlite | آخرین push اکتبر ۲۰۲۴ در متادیتای موجود؛ rich-text CRDT پیاده‌نشده؛ ریسک |
| Triplit | آینده‌ی OSS/پشتیبانی نامطمئن بعد از پیوستن به Supabase |
| Automerge/Loro | binding ProseMirror نابالغ‌تر از Yjs؛ بازنگری در ۲۰۲۷ |
| SQLite-فایل-سینک | خراب شدن فایل WAL با سینک فایل [کد: ADR-0003] |
| Jazz/Evolu/LiveStore | عمق ارزیابی ناکافی؛ framework lock-in؛ نه رد قطعی |

## C. محل منطق

### C-۱. مقایسه

| معیار | **TypeScript core** (+Rust برای I/O) | Rust→WASM برای وب (وضع فعلی) | Rust-native و وب از راه دیگر (مثلاً سرویس سمت سرور) |
|---|---|---|---|
| یک پیاده‌سازی برای وب+دسکتاپ | **بله** (WebView دسکتاپ همان JS را اجرا می‌کند) | بله برای ادغام، ولی کلاینت HTTP/ذخیره‌ی وب هنوز TS؛ واقعاً دو لایه | فقط اگر وب thin-client باشد (یعنی آفلاین نیست) |
| ادیتور (TipTap/Yjs) | همان زبان؛ `Y.Doc` یکی است | **دو پیاده‌سازی Yjs در یک مسیر** (yjs در UI + yrs در WASM): نیازمند پاریتی [کد: 26 مورد parity] | — |
| Safari/WebKit | بدون ریسک WASM-خاص (به‌جز SQLite-WASM اگر انتخاب شود) | WASM در Safari خوب است ولی اندازه/bootstrap و دیباگ سخت‌تر | — |
| دیباگ | DevTools + stack trace TS | WASM stack trace ضعیف | — |
| استخدام | TS گسترده‌تر | Rust+WASM+wasm-bindgen نادرتر | — |
| عملکرد ۱۰k+ صفحه | قابل‌قبول برای متادیتا (رجیستر/ایندکس)؛ Yjs فقط برای صفحه‌های بازشده؛ **تحقق نشده، باید در اسپایک سنجیده شود** | سریع‌تر برای ingest دسته‌ای (yrs) [استنباط] | — |
| نیاز واقعی به Rust | I/O: فایل، SQLite، FTS5، keychain، قفل Vault، loopback MCP، mirror Markdown | همه‌ی بالا + منطق | — |
| ریسک | WebView پس‌زمینه در دسکتاپ (throttle وقتی پنجره مخفی است)؛ iOS Safari بدون سینک پس‌زمینه | سنگین‌ترین نگه‌داری | — |

### C-۲. بررسی «آیا چیزی بدون WebView به `yrs` نیاز دارد؟» (توصیه‌ی بازبینی)

- **MCP/AI:** `mcp.rs` فقط ترابری loopback است و رویداد را به webview می‌فرستد؛ منطق سند در TS است **[کد: `mcp.rs` خط ۱ و `emit("mcp-request")`]**. دستورالعمل MCP هم می‌گوید «app must stay open». پس به `yrs` بدون WebView نیازی نیست.
- **سرور Go:** کور؛ compaction با کلاینت؛ بکاپ سرور فقط بایت می‌کپی. **[کد: server/README + ADR-0004؛ استنباط برای compaction کلاینتی]**
- **بکاپ/اکسپورت دسکتاپ بدون ادیتور باز:** باید بدون WebView هم خروجی بدهد؟ اگر بخواهید «CLI headless»، آنگاه یا باید یک Node/Bun sidecar با همان core TS بسازید (همان کد) یا `yrs` را نگه دارید. **پیشنهاد:** v1 بدون CLI headless؛ اگر لازم شد، Node sidecar با همان بسته‌ی TS. **[استنباط]**
- **پیامد:** `nevis-core` (قواعد ادغام)، `nevis-wasm`، `sync/mod.rs` (۳٬۰۷۵ خط)، `blockmerge.rs`، `db_merge.rs`، `kv_merge.rs`، `plan.rs` منسوخ می‌شوند. **این بخش‌هایی از ADR-0007 (تصمیم ۱ و مراحل ۱–۲) را برمی‌گرداند.** دلیل ADR-0007 («ادغام بایت‌به‌بایت یکسان» برای md5) با CRDT بی‌اثر می‌شود؛ اما تعهد «یک پیاده‌سازی» حفظ می‌شود، فقط با زبان دیگر.

### C-۳. SQLite-WASM و OPFS (برای وب)

| نکته | یافته | برچسب |
|---|---|---|
| انتخاب VFS | `opfs-sahpool`/`AccessHandlePoolVFS`: تک‌اتصال؛ چندتب نیاز به worker مشترک دارد و **SharedWorker نمی‌تواند** چون sync access handle در آن نیست. `OPFSCoopSyncVFS` (wa-sqlite): چندتب مستقیم، بدون نیاز COOP/COEP، سریع تا >۱GB. `opfs` در sqlite-wasm رسمی COOP/COEP می‌خواهد | [مستند] https://powersync.com/blog/sqlite-persistence-on-the-web |
| Safari | `IDBBatchAtomicVFS` روی کوئری‌های بزرگ `RangeError: Maximum call stack` داده؛ حالت خصوصی OPFS ندارد؛ JSPI ندارد (Asyncify)؛ `readwrite-unsafe` ندارد | [مستند] همان |
| iOS 26 | گزارشی (انجمن sqlite.org) از قفل ماندگار بعد از بستن DB/worker روی iOS 26 با sahpool؛ فقط روی iOS | [ثانویه] https://sqlite.org/forum/forumpost/449ae66eb1 (از خلاصه‌ی جست‌وجو؛ صفحه‌ی اصلی خوانده نشد) |
| Safari <17 | باگ sub-worker در OPFS پیش‌فرض؛ sahpool راه‌حل | [ثانویه] |
| چندتب و lock مشترک | `OPFSCoopSyncVFS` گزارش deadlock در Chrome و Safari هم دارد | [ثانویه] https://github.com/powersync-ja/powersync-js/issues/785 |
| مدت ماندگاری Safari | سهمیه‌ی هر origin تا ۶۰٪ دیسک برای مرورگر و ۱۵٪ برای برنامه‌های دیگر (Safari 17+)؛ **eviction خودکار** برای origin بدون تعامل کاربر («per ITP») و فشار فضا؛ `persist()` با heuristic (مثلاً Home Screen web app) داده می‌شود؛ بدون prompt | [مستند] https://webkit.org/blog/14403/updates-to-storage-policy/ |
| سقف ۷‌روزه‌ی داده‌ی script-writable در Safari مرورگر؛ معافیت Home Screen app | **در همین صفحه‌ی WebKit نبود**؛ از حافظه می‌دانم ولی تأیید نشد → باید در اسپایک روی دستگاه واقعی سنجید | [حافظه، تأییدنشده] |

**نتیجه‌ی C-۳ [استنباط]:** برای وب، **IndexedDB منبع حقیقت قانونی بماند** (بیشترین عمر و سازگاری در Safari؛ داده‌ی ما نسبتاً KV/log-شکل است و نیاز به SQL ندارد) و ایندکس جست‌وجوی مشتق در **SQLite-WASM با FTS5 در یک dedicated worker که فقط leader tab (Web Lock) مالک اوست** یا ایندکس JS؛ هر دو مشتق و قابل بازسازی‌اند، پس ریسک OPFS/eviction به «ساخت دوباره‌ی ایندکس» محدود می‌ماند، نه از دست رفتن داده. SQLite-WASM به‌عنوان *منبع حقیقت* در وب را تا اثبات روی Safari/iOS واقعی انتخاب نکنید.

### C-۴. توصیه
**TS core + «پورت»های باریک:** `Store` (تراکنش batch روی جدول‌های لاگ/رجیستر/سند)، `Net` (HTTP/SSE)، `Search` (ایندکس)، `Blobs`، `Clock`. آداپتورها: IndexedDB (وب)، SQLite از طریق Tauri command (دسکتاپ؛ همان schema)، in-memory (تست)، `node:sqlite` (تست Node). **منطق در یک جا، آداپتورها دو تا؛** تفاوت از «دو نسخه‌ی منطق» خیلی کوچک‌تر است.

## D. نقش سرور

### D-۱. شکل پروتکل (پیشنهاد)

| مورد | پیشنهاد |
|---|---|
| لاگ | append-only per-workspace، `seq` یکنواخت سروری. `POST /v1/w/{ws}/ops` بدنه: `{ops:[envelope...]}`؛ پاسخ: `{acked:[{id,seq}], head}`؛ **idempotent با `id` سمت کلاینت (UUIDv7)**؛ تکرار id = همان `seq` قبلی. `GET /v1/w/{ws}/ops?after=SEQ&limit=N&doc=ID?` |
| push | SSE (`GET /v1/w/{ws}/events`) یا long-poll (الان وجود دارد [کد: README server]) با پیام «head=SEQ»؛ WebSocket فقط اگر لازم شد (پراکسی/Safari ملاحظه) |
| blob | `PUT /v1/w/{ws}/blobs/{sha256}` resumable (موجود [کد])؛ **محتوا اول، ارجاع بعد** (موجود [کد]) |
| snapshot | `POST .../snapshots {doc, coversSeq, payload}`؛ سرور آن را به‌صورت یک op جدید با seq تازه ثبت می‌کند و opهای قدیمی همان doc تا `coversSeq` را **پس از مهلت cold-retention** (مثلاً ۳۰ روز) حذف فیزیکی می‌کند |
| ثبت دستگاه | `devices` با آخرین `cursor` برای محاسبه‌ی «حداقل cursor»؛ دستگاه ساکت >۹۰ روز از محاسبه حذف و هنگام بازگشت full-resync می‌شود |
| سقف و فشار | حداکثر اندازه‌ی batch/op، rate limit، 429 با `Retry-After` (موجود [کد]) |

### D-۲. E2EE: چه چیزی باید قبل از انتشار تصمیم بگیرد

**چرا مهم است:** پس از انتشار، افزودن E2EE یعنی مهاجرت کل داده و پروتکل. ADR-0004 هم می‌گوید سرور فعلی E2EE نیست و یک بیت پرچم در `NVPS` رزرو شده ولی استفاده نمی‌شود **[کد]**.

| تصمیم | پیشنهاد | اثر بر ... |
|---|---|---|
| envelope | هدر **غیررمز** کم: `{v, id, ws, dev, doc?, sv, kid, n}`؛ `payload` بایت مات | سرور فقط ترتیب/نگه‌داری/اعمال نسخه؛ نه محتوا |
| شناسه‌ها | تصادفی، بدون عنوان/نام در مسیر یا هدر؛ UUIDv7 زمان ساخت را لو می‌دهد (سرور هر دو را از زمان دریافت می‌داند؛ پذیرفتنی) | حریم خصوصی |
| `kid` | از روز اول در قالب (۰ = بدون رمز) | چرخش کلید |
| blob id | `sha256(بایت‌های ذخیره‌شده)`؛ در حالت E2EE بایت رمزشده (یا HMAC کلیددار) تا سرور نتواند وجود فایل مشخص را تأیید کند | dedup فقط درون workspace |
| جست‌وجو | **از قبل کلاینتی** [کد: FTS5 محلی]؛ پس با E2EE سازگار | بدون تغییر |
| compaction | **کلاینتی** (سرور Yjs نمی‌فهمد)؛ با E2EE سازگار | همین طراحی |
| AI/MCP | از طریق برنامه و WebView (متن رمزگشایی‌شده) [کد] → سازگار؛ ولی هر «AI سمت سرور» ناممکن می‌شود | محصول |
| احراز هویت و کلید | رمز عبور حساب ≠ کلید داده؛ کلید workspace تصادفی، مهر‌شده با Argon2id از passphrase جدا یا کلید بازیابی؛ **بازیابی فراموشی = از دست رفتن داده** باید در UX صریح باشد | UX/پشتیبانی |
| الگوریتم | AES-256-GCM با WebCrypto (Safari و دسکتاپ بدون وابستگی)؛ AAD = `ws|doc|id|sv` | [استنباط] |
| تأثیر فشرده‌سازی | فشرده‌سازی **قبل** از رمز | اندازه |

**پیشنهاد:** v1 با `kid=0` (متن‌آشکار روی سرور) ولی همه‌ی موارد بالا از روز اول. «سرور هرگز payload را تفسیر نکند» را با آزمون (سرور بدون هیچ import از ساختار صفحه) تضمین کنید.

### D-۳. احراز هویت وب

| گزینه | مزیت | عیب |
|---|---|---|
| **کوکی httpOnly + Secure + SameSite=Lax** (توصیه، چون وب هم‌origin سرو می‌شود [کد: ADR-0007 `WEB_DIR`]) | خواندنش با XSS ممکن نیست؛ ITP در Safari سقف ۷ روز را برای کوکی ساخته‌شده با JS دارد نه HttpOnly سروری [حافظه، تأییدنشده] | نیاز CSRF: سربرگ سفارشی اجباری (`X-Nevis-Client`) + بررسی Origin؛ XSS هنوز می‌تواند درون نشست عمل کند |
| توکن در IndexedDB (فعلی [کد: ADR-0007]) | ساده، مناسب origin جدا | XSS آن را می‌دزدد؛ فقط CSP جلوی آن است |
| دسکتاپ | توکن دستگاه در keychain سیستم‌عامل (Bearer) | — |

برای E2EE، کلید داده را در وب به‌صورت `CryptoKey` غیرقابل-export در IDB نگه دارید.

### D-۴. حداقل نسخه‌ی کلاینت

- ADR-0007 مرحله ۳ قبلاً `min_api` per-vault (ratchet فقط به بالا) و ۴۲۶ دارد **[کد]**؛ نگهش دارید و دو بُعد اضافه کنید: **`proto`** (قرارداد HTTP) و **`sv`** (schema بدنه/رجیستر). هر op هدر `sv` دارد؛ سرور اجازه‌ی نوشتن زیر `min_sv` را نمی‌دهد؛ کلاینت op با `sv` بالاتر را اعمال نمی‌کند و cursor را جلو نمی‌برد (حالت «به‌روزرسانی لازم»).
- وب: وقتی سرور ۴۲۶ می‌دهد، service worker باید `skipWaiting` + بارگذاری مجدد را درخواست کند (کلاینت وب کهنه‌ی cache‌شده یکی از خطرناک‌ترین خطاهای نسخه است) **[استنباط]**.
- الگوی هم‌خانواده: `appMinVersion` در `info.json` Joplin [مستند].

## E. جست‌وجو، تاریخچه، پیوست

### E-۱. جست‌وجوی متن فارسی

**اصل:** نرمال‌سازی **یک بار، در TS** (`normalizeSearch`) هم برای ایندکس و هم برای query؛ ایندکس فقط توکن‌بندی ساده روی متن نرمال‌شده انجام می‌دهد (FTS5 `unicode61`). امروز `db/normalize.mjs` و `normalizeFa` در ADR-0002 همین کار را می‌کنند **[کد]**؛ منطق باید فقط یک نسخه داشته باشد.

| قاعده | جزئیات |
|---|---|
| یکسان‌سازی حروف | ي/ى (U+064A/U+0649) → ی (U+06CC)؛ ك (U+0643) → ک (U+06A9)؛ ە/ۀ → ه؛ ة → ه؛ أ إ ٱ → ا (آ→ا برای جست‌وجو) |
| ارقام | ۰-۹ (U+06F0..) و ٠-٩ (U+0660..) → ASCII 0-9؛ جداکننده‌ی اعشار/هزارگان عربی → `.`/`,` |
| حذف | اعراب U+064B–U+065F، U+0670، کشیده U+0640، علامت‌های جهت (U+200E/200F/202A–202E/2066–2069) |
| **ZWNJ (U+200C)** | هم به‌صورت حذف‌شده (`میخواهم`) و هم به‌صورت جداشده (`می خواهم`) ایندکس شود تا «می‌خواهم» و «میخواهم» و «خواهم» هر سه یافته شوند؛ query به همان دو صورت نرمال می‌شود |
| NFKC | حروف presentation (ﻻ، ﻑ...) → فرم پایه |
| prefix | جست‌وجوی پیشوندی (موجود [کد]) |
| substring | trigram اختیاری برای جست‌وجوی میان‌واژه؛ هزینه‌ی اندازه [استنباط] |
| ریشه‌یابی | عمداً نه؛ فارسی stemmer قابل‌اتکای سبک ندارد؛ prefix کافی است [استنباط] |
| **آزمون** | مجموعه‌ی آزمون جفت (متن، query، انتظار) مشترک بین Rust(FTS5) و وب؛ ADR-0002 همین الگو را دارد [کد: test-schema.mjs] |

**ایندکس وب:** مشتق، در IndexedDB یا SQLite-WASM؛ باید با همان توکن‌ساز بسازد. اگر ایندکس JS انتخاب شد، سقف حافظه برای ۱۰k صفحه را در اسپایک بسنجید.

### E-۲. Backlinks / گراف
جدول مشتق `page_links(src, dst, blockId?)` و `block_refs`؛ هنگام هر تغییر محلی یا دریافتی همان صفحه (debounced) از روی Y.Doc/JSON بازسازی می‌شود؛ **هرگز سینک نمی‌شود** (مثل ADR-0002 [کد]). گره‌ی `pageLink` در سند فقط `dstId` پایدار + برچسب cache‌شده نگه می‌دارد؛ تغییر عنوان فقط برچسب را در نمایش به‌روز می‌کند.

### E-۳. تاریخچه‌ی صفحه
- **رویداد `version` immutable** در لاگ (هم‌گام): `{id, doc, ts, dev, kind: auto|manual|restore-point, content: PM JSON فشرده}`. ساختن از روی JSON فعلی با `Y.Doc` تازه (بدون تاریخچه‌ی CRDT و بدون رشد).
- **thinning:** همه‌ی نسخه‌ها تا ۱ ساعت؛ ساعتی تا ۲۴ ساعت؛ روزانه تا ۳۰ روز؛ هفتگی بعد از آن؛ «دستی» هرگز خودکار حذف نشود. حذف = op tombstone (رجیستر).
- **بازگردانی:** diff بین محتوای فعلی و نسخه، به‌صورت یک ترنزاکشن عادی در `Y.Doc` زنده (نه برگرداندن CRDT)، تا بقیه‌ی دستگاه‌ها طبیعی همگرا شوند. undo/MCP `undo_document_edit` از همین مسیر.
- **چرا نه Yjs snapshot:** B-۳.

### E-۴. پیوست‌ها و GC
- نام‌گذاری: `blob = sha256(بایت‌های ذخیره‌شده)`؛ در سند: `{blob, name, mime, size}`؛ دسکتاپ: `files/ab/<sha256>` (همان فعلی [کد]).
- **ارجاع‌ها مشتق‌اند** (`attachment_refs` از هر صفحه). GC سرور: کلاینت *leader* (دسکتاپ) دوره‌ای مجموعه‌ی ارجاع‌شده‌ی «همه‌ی صفحه‌ها + نسخه‌های تاریخچه + سطل» را می‌فرستد؛ سرور blobهای **نه‌ارجاع‌شده و قدیمی‌تر از مهلت (مثلاً ۳۰ روز از آخرین ارجاع/آپلود)** را به سطل می‌برد و بعد حذف می‌کند. کلاینت blob محلی را تا زمانی که opِ ارجاع‌دهنده‌اش ack نشده نگه می‌دارد. با E2EE هم کار می‌کند چون سرور فقط هش را می‌بیند (با ملاحظه‌ی HMAC). **[استنباط؛ نمونه‌ی مشابه در کد فعلی: `vaults/gc.go`]**
- بدون ارجاع در تاریخچه، بازگردانی نسخه‌ی قدیمی به پیوست حذف‌شده می‌رسد؛ پس ارجاع تاریخچه را بشمارید.

## F. فهرست «پیش از انتشار»

| مورد | تصمیم پیشنهادی | چرا زود |
|---|---|---|
| شناسه‌ها | UUIDv7 برای موجودیت و op؛ `dev` = UUID تصادفی؛ doc id = همان page id | تغییر بعد از انتشار ناممکن [کد: ADR-0002 هم v7] |
| HLC | ۵۲ بیت physical ms + ۱۶ بیت counter + شناسه‌ی کامل `dev` برای tiebreak؛ clamp اختلاف ساعت با حد (مثلاً ۲ ساعت) روی **دریافت** نه فقط ارسال | همگرایی |
| نسخه‌ی schema بدنه | `sv` در هر op و در `NVSN` blob؛ قاعده‌ی «refuse if greater»؛ migration فقط **افزایشی** و lazily با op مهاجرت | شکستن بی‌صدا [کد: ADR-0004 جدایی بتا] |
| نسخه‌ی قالب | `proto`, `sv`, `fmt` (export) مستقل؛ هر کدام رتبه‌ی خودش | |
| Tombstone retention | رجیستر `deleted` تا وقتی همه‌ی دستگاه‌های ثبت‌شده فعال از آن گذشته‌اند؛ دستگاه ساکت >۹۰ روز = full resync؛ حداقل ۹۰ روز | resurrection |
| Compaction | کلاینتی؛ آستانه: >۲۰۰ update یا >۱MB tail per doc؛ مهلت cold-retention سرور ۳۰ روز | |
| رمزنگاری | `kid` و envelope از ابتدا؛ E2EE بعداً (D-۲) | |
| Yjs pin | **Yjs 13.x دقیق + `@tiptap/y-tiptap` دقیق (الان 3.0.2) و `yrs` فقط برای مهاجرت داده‌ی قدیمی؛ lockfile + آزمون `yjs-compat`؛ برنامه‌ی مهاجرت 13→14 پس از پایدار شدن `@y/prosemirror`** | binary format مشترک بین نسخه‌ها پایدار نیست [ثانویه] |
| import/export | bundle بدون اتلاف + mirror Markdown + import Markdown/Obsidian/Notion-zip | اعتماد |
| نرمال‌سازی جست‌وجو | نسخه‌ی `normVersion` در ایندکس؛ تغییرش = بازسازی | |
| `blockId` | attr پایدار روی همه‌ی بلاک‌ها (UniqueID)، dedupe هنگام paste/split | لینک بلاک، MCP، export `^id` |
| محدودیت‌ها | حداکثر اندازه‌ی op/blob/صفحه | حمله و خرابی |
| دستگاه و کلید | ثبت دستگاه، ابطال دستگاه | امنیت |
| پایدار کردن مسیر وب | `persist()`، تشخیص eviction، «بازیابی از سرور» | Safari |
| مهاجرت از Vault فعلی | مبدل یک‌باره (چون مشتری ندارید) | |

---

# ۳) مدل داده و اسکچ فرمت (برای شروع ADR)

## ۳-۱. موجودیت‌ها

| موجودیت | جایگاه | نوع هم‌گرایی |
|---|---|---|
| `Workspace{id, name, createdBy}` | سرور + رجیستر | LWW |
| `Device{id, name, lastCursor}` | سرور | — |
| `Page{id, kind: page\|folder\|database\|row, parentId, sortKey, title, icon, cover, tags, dir, trashedAt, deleted}` | رجیستر per-field | LWW (HLC) |
| `PageBody` | `Y.Doc` per page (`content` XmlFragment) | Yjs 13 |
| `Property{id, dbId, name, type, options, sortKey}` | رجیستر | LWW |
| `View{id, dbId, config}` | رجیستر (config یک فیلد یا چند فیلد) | LWW |
| `Cell{rowId, propId, value}` | رجیستر | LWW |
| `SetEl{rowId, propId, elemId, present}` | multi-select/relation/tags | add-wins LWW per element |
| `Card{id, ...}` + `Review{id, cardId, ts, rating, dev}` | رجیستر + رویداد immutable | LWW + union |
| `Setting{key, value}` | رجیستر | LWW |
| `SavedSearch{id, query}` | رجیستر | LWW |
| `Version{id, doc, ts, kind, content}` | رویداد immutable | union |
| `Blob{hash, size, mime}` | blob store | immutable |
| مشتق (سینک نمی‌شود) | `fts`, `page_links`, `attachment_refs`, `tasks_index`, `srs_state`, `projection(JSON)` | بازسازی |

## ۳-۲. envelope و payload

```
Envelope (JSON فشرده یا CBOR؛ تنها بخش قابل‌دیدن برای سرور)
{ v: 1,                 // نسخه‌ی envelope
  id: "<uuidv7>",       // idempotency
  ws: "<id>", dev: "<id>",
  doc: "<id>" | null,   // برای واکشی per-doc (تصادفی، بدون عنوان)
  sv: 5,                // schema version نویسنده
  kid: 0,               // 0 = بدون رمز، >0 = کلید
  n: "<nonce base64>",  // فقط اگر kid>0
  p: <bytes> }          // payload مات

Payload (پس از رمزگشایی، MessagePack/CBOR)
{ k: "y.update", doc, u: <bytes> }                       // به‌روزرسانی Yjs
{ k: "y.snap",   doc, u: <bytes>, covers: <stateVector> } // snapshot کلاینت‌ساز
{ k: "reg.set",  e: "page", id, f: "title", v, h: "<hlc>" }
{ k: "reg.del",  e: "row", id, h }                        // = set deleted=true
{ k: "set.add"|"set.rem", e, id, f, el, h }
{ k: "evt",      e: "review"|"version", id, body }        // immutable
{ k: "reg.snap", e, covers: "<hlc range>", entries: [...] } // compaction رجیسترها
```

- **HLC string**: `"%013x-%04x-<devFull>"` (ms در ۵۲ بیت = ۱۳ رقم hex، counter ۱۶ بیت، و **شناسه‌ی کامل دستگاه** به‌عنوان tiebreak) → مرتب‌سازی لغت‌نامه‌ای = یک ترتیب کلی (total order)؛ کوتاه کردن شناسه‌ی دستگاه ممکن است دو HLC یکسان بسازد و LWW را نامعین کند.
- ترتیب اعمال: ترتیب `seq` فقط برای ثبات cursor؛ **نتیجه به ترتیب اعمال وابسته نیست** (Yjs و LWW جابه‌جایی‌پذیرند).

## ۳-۳. قالب snapshot/blob (`NVSN`)

```
magic "NVSN" | fmt:u8 | flags:u8 (bit0=encrypted, bit1=deflate-raw) | kid:u32 | sv:u16
| len:u32 | payload (Y update v1 یا CBOR رجیستر)
```
بیت «رمز» با قرارداد `NVPS` فعلی که در `page_state.rs` رزرو شده هماهنگ است **[کد: ADR-0004]**. فشرده‌سازی `deflate-raw` (CompressionStream؛ در Safari مدرن موجود است [حافظه]).

## ۳-۴. ذخیره‌ی محلی (SQLite دسکتاپ؛ همان جدول‌ها = object store در IDB)

```sql
doc_snap(doc PK, snap BLOB, seq_applied INT, sv INT);
doc_tail(doc, n INT, upd BLOB, PRIMARY KEY(doc,n));       -- update های فشرده‌نشده
reg(ent, id, field, val BLOB, hlc TEXT, PRIMARY KEY(ent,id,field));
set_el(ent, id, field, el, present INT, hlc TEXT, PRIMARY KEY(ent,id,field,el));
evt(id PK, kind, ent, ts, body BLOB);
outbox(id PK, env BLOB, state);                           -- ارسال‌نشده/ack نشده
blob(hash PK, size, mime, local INT, remote INT);
meta(k PK, v);                                            -- cursor, hlc, device
-- مشتق:
fts(...), page_links(src,dst,block), attachment_refs(hash,doc), tasks_index(...), srs_state(...)
```
نوشتن هر تغییر = **یک تراکنش** که `doc_tail`/`reg` و `outbox` را با هم می‌نویسد (بدون «نصفه»).

## ۳-۵. نام‌گذاری پیوست
دیسک: `files/<h[0:2]>/<sha256>` (+ `.json` متادیتا اختیاری)؛ سرور: `blobs/<sha256>`؛ ارجاع در سند: `blob:<sha256>`؛ نام نمایشی فقط در سند.

## ۳-۶. قالب export

```
MyNotes-export/
  manifest.json            {format:"nevis-export", v:1, ws, exportedAt, sv}
  pages/<slug>--<id8>.md   Markdown + YAML front-matter
  databases/<slug>.csv + <slug>.schema.yaml
  attachments/<sha8>-<name>.<ext>
  .nevis/pages/<id>.json   ProseMirror JSON بدون اتلاف
  .nevis/history/<id>/<ts>.json
```
front-matter: `id, title, parent, tags, dir, icon, created, updated, aliases`. بدنه: heading/لیست/کد/ریاضی `$..$`؛ callout با `> [!note]`؛ toggle با `<details>`؛ بلوک با جهت متفاوت از صفحه با `<div dir="rtl">`؛ id بلوک `^id`؛ لینک `[[عنوان]]` + نگاشت id در front-matter؛ جدول ساده GFM و جدول پیچیده HTML؛ mermaid در fenced block؛ نقاشی = پیوست؛ ستون‌ها = `<div class="nv-columns">`. اتلاف مستند در README خروجی.

---

# ۴) برنامه‌ی مرحله‌ای و اسپایک ۳ تا ۵ روزه

## مراحل
0. **اسپایک S1** (پایین).
1. ADR جدید «Ops + Yjs + LWW»؛ فریز مسیر قدیمی.
2. هسته‌ی TS + سرور لاگ + مبدل Vault→ops.
3. ادیتور روی y-tiptap + جدول‌ها/دیتابیس‌ها روی رجیستر.
4. جست‌وجو/تاریخچه/پیوست‌ها و export.
5. وب (IDB + PWA) و آزمون Safari/iOS واقعی.
6. امنیت، fuzz عمیق، حذف کد قدیمی.

## اسپایک S1 (۳–۵ روز): سه ناشناخته‌ای که اگر شکست بخورند توصیه را برمی‌گردانند

**فقط این سه را بسازید و بسنجید:**
- **(a)** `@tiptap/y-tiptap` روی schema واقعی با تایپ فارسی (IME)، `dir` هر بلاک و جدول، **هم‌زمان با رسیدن update دوردست**، روی دسکتاپ و روی iPhone واقعی (معیار ۸ و S1).
- **(b)** هم‌گرایی و idempotency لاگ در برابر یک endpoint حداقلی Go (`POST ops` idempotent، `GET ops?after`)، فقط با آداپتور in-memory و IndexedDB (معیار ۱–۳). بسته‌ی `core` فقط: HLC، رجیستر LWW، outbox/cursor.
- **(c)** ماندگاری IndexedDB در Safari و leader بودن با Web Lock بین دو تب (S2، S3، S4).

**معیارها:**

| # | معیار | قبول | رد |
|---|---|---|---|
| 1 | fuzz: ۳ replica، ۲۰۰ seed×۱۰k عملیات تصادفی (ویرایش متن، attr `dir`، سطر جدول، جابه‌جایی بلاک، حذف/بازگردانی، رجیستر، add-wins set) با offline، تأخیر، **تحویل تکراری و بی‌ترتیب** | همه همگرا؛ **معیار برابری:** JSON پروجکشن ProseMirror deep-equal + dump مرتب‌شده‌ی رجیسترها و setها (نه برابری بایتی `encodeStateAsUpdate`؛ split/merge ساختارها در Yjs بین replicaها با ترتیب/دسته‌بندی متفاوت ممکن است بایت متفاوت بدهد و واگرایی نیست؛ پایداری بایتی تأیید نشده است) | هر واگرایی در پروجکشن یا رجیسترها |
| 2 | ارسال دوباره‌ی همان batch ۱۰ بار | `seq` و حالت تغییر نکند | |
| 3 | قطع شبکه وسط ارسال | داده‌ی ack‌نشده از دست نرود | |
| 8 | ادیتور واقعی: تایپ فارسی با IME روی دسکتاپ و وب با دریافت هم‌زمان update | caret/composition نپرد؛ `dir` هر بلاک سینک شود | caret بپرد یا composition قطع شود ← fallback «JSON + ingest» (تصمیم A فعلی) |

**Safari/iOS: همه نیازمند اجرای واقعی روی Safari ≥۱۷ (macOS) و iPhone با iOS ۲۶ است؛ در این پژوهش و در محیط ADR-0007 انجام نشد و در این محیط قابل انجام نیست.**

| # | معیار | قبول |
|---|---|---|
| S1 | معیارهای ۱–۳ و ۸ روی Safari macOS و iOS (تب و Home Screen PWA) | سبز |
| S2 | ۵۰۰MB داده‌ی تستی در IDB؛ `persisted()`/`estimate()` ثبت شود؛ اپ ۲۰ بار kill شود | صفر از دست رفتن |
| S3 | دو تب Safari macOS با Web Lock leader؛ ویرایش در یکی، همگرایی در دیگری | بدون clientID تکراری، بدون deadlock |
| S4 | iOS: پس‌زمینه‌رفتن/برگشتن وسط ویرایش و سینک | بدون از دست رفتن؛ ادامه از cursor |
| S6 | ۷+ روز بدون استفاده: بقای داده‌ی IDB در تب Safari و در Home Screen PWA (تأیید ادعای «حافظه»ی C-۳) | نتیجه‌ی واقعی ثبت شود |
| S7 | `CompressionStream('deflate-raw')`، Web Locks، `crypto.subtle` AES-GCM روی iOS | موجود |

**خروجی اسپایک:** گزارش یک‌صفحه‌ای با عددها + تصمیم ادیتور (y-tiptap مستقیم یا fallback). اگر (a) یا (c) شکست بخورد، توصیه‌ی B/C را بازنگری کنید.

## مرحله‌ی ۲ (پس از موفقیت S1؛ همین معیارها، فقط جابه‌جا شده‌اند)

| # | معیار | قبول |
|---|---|---|
| 4 | compaction: صفحه با ۵۰k ویرایش کلیدی | snapshot ≤ ۳× JSON فشرده؛ باز کردن < ۳۰۰ms؛ رد: > ۱۰× |
| 5 | ۱۰k صفحه (با مبدل `pages-state/*.bin`→ops): شروع تا فهرست قابل‌استفاده | < ۲s؛ باز کردن صفحه < ۲۰۰ms؛ رد: > ۵s |
| 6 | تأخیر ویرایش→دستگاه دوم (LAN) | p95 < ۱٫۵s |
| 7 | جست‌وجو ۱۰k صفحه فارسی+انگلیسی؛ ۵۰ جفت آزمون نرمال‌سازی (ي/ك، ارقام، ZWNJ دو حالته، اعراب) | prefix p95 < ۵۰ms؛ همه سبز |
| 9 | صفحه‌ی ۱۵k بلاک | باز کردن < ۲s؛ تایپ بدون lag |
| 10 | سرور کور: هیچ کدی در سرور payload را parse نکند (بازبینی کد) | |
| S5 | ارزیابی SQLite-WASM برای ایندکس مشتق: `OPFSCoopSyncVFS` و `opfs-sahpool` در dedicated worker، چندتب، resume بعد از suspend در iOS ۲۶ (گزارش قفل ماندگار)، **روی دستگاه واقعی** | بدون قفل ماندگار؛ وگرنه ایندکس JS |
| — | آداپتور SQLite دسکتاپ از راه Tauri IPC: هر نوشتن Store از IPC می‌گذرد؛ به‌روزرسانی‌های Yjs هر کلید باید در آداپتور batch/debounce شوند؛ هزینه‌ی IPC اندازه‌گیری شود | p95 ذخیره < ۵۰ms در تایپ سریع |

---

# ۵) ریسک‌ها و ناشناخته‌ها

| ریسک | شدت | کاهش |
|---|---|---|
| `@tiptap/y-tiptap` با فارسی/IME/جهت per-block یا جدول‌های بزرگ رفتار بد دارد | بالا | معیار ۸؛ fallback: JSON + ingest/diff |
| Yjs 14 جدید و پایان‌ناپذیری ۱۳ | متوسط | pin؛ آزمون سازگاری باینری؛ بودجه‌ی مهاجرت |
| `move` بلاک در Yjs | متوسط | تعریف «حذف+درج»؛ ریسک گم شدن ویرایش هم‌زمان را بپذیرید؛ ارزیابی Loro در ۲۰۲۷ |
| رشد لاگ/حالت | متوسط | compaction کلاینتی + مهلت cold |
| compaction کلاینتی اشتباه ← از دست رفتن op | بالا | نگه‌داری opهای قدیمی ۳۰ روز؛ آزمون؛ بکاپ سرور |
| هر نوشتن Store روی دسکتاپ از Tauri IPC می‌گذرد (هزینه‌ی نامعلوم برای به‌روزرسانی‌های per-keystroke) | متوسط | batch/debounce در آداپتور؛ اندازه‌گیری در مرحله‌ی ۲ |
| WebView دسکتاپ در پس‌زمینه/بسته | متوسط | سینک در پنجره‌ی پنهان یا tray؛ تأییدنشده؛ در اسپایک بسنجید |
| Safari: eviction، ITP، OPFS در iOS ۲۶، IDB | بالا و تأییدنشده | اسپایک S1–S7؛ IDB منبع حقیقت؛ `persist()`؛ بازیابی از سرور |
| XSS در وب = تصاحب حساب | بالا | CSP (موجود)، sanitize HTML/Mermaid/Excalidraw، کوکی HttpOnly، CryptoKey غیرقابل-export |
| E2EE بعداً اضافه شود | متوسط | envelope/`kid`/سرور کور از اکنون |
| معماری رجیستر برای دیتابیس‌های بزرگ (۱۰۰k ردیف) | متوسط | ایندکس مشتق، صفحه‌بندی؛ آزمون عملکرد جدا (هنوز ندارید؛ `db/bench` فعلی برای مدل قبلی است [کد]) |
| ارزیابی ناقص: Jazz/Evolu/LiveStore، Bear/Craft/Capacities/Tana/Trilium، Notion/AppFlowy داخلی | کم تا متوسط | مطالعه‌ی تکمیلی؛ تصمیم بر آن‌ها تکیه ندارد |
| مبدل داده‌ی قدیمی | کم | مشتری ندارید؛ فقط Vaultهای توسعه |
| ادعای «سقف ۷‌روزه»ی Safari | تأییدنشده | S6 |

---

# ۶) چه چیزی از کد فعلی بماند

| بماند | چرا |
|---|---|
| **سرور Go**: حساب‌ها (scrypt، recovery key، PoW، limiter)، blobها با SHA-256 و resumable، long-poll hub، بکاپ SQLite، `min_api` ratchet، سرو وب هم‌origin با CSP، health/purge | هسته‌ی مفید و کور [کد: server/README، ADR-0004/0007]. فقط endpoint لاگ و snapshot اضافه می‌شود؛ مسیرهای path-keyed/CAS بازنشسته |
| محتوای ادیتور: schema TipTap، extensionهای dir، block UI، **MCP و سرویس سند در TS** و `mcp.rs` (ترابری) | [کد] |
| `normalizeFa`/`db/normalize.mjs`، ایندکس FTS5 و آزمون‌هایش، `page_links` | [کد: ADR-0002] |
| UUIDv7، `sort_key` fractional، سطل زباله‌ی رفتاری | [کد: ADR-0002] |
| آزمون‌های چنددستگاهی و زیرساخت اسکریپت‌ها (`websync-test.sh`، `cross-device-test.sh`، `yjs-compat.sh`)؛ آن‌ها را به پروتکل جدید تطبیق دهید | الگوی آزمون ارزشمند [کد: ADR-0007] |
| قفل Vault/نوشتن atomic/آماده‌سازی دسکتاپ (Rust I/O) | [کد: `vault_lock.rs`, `vault.rs`] |
| پیاده‌سازی zip/export (`portable.rs`، ۷۳۷ خط) — محتوا بررسی نشد؛ به‌عنوان نقطه‌ی شروع bundle ببینید | **تأییدنشده** |
| PWA shell، sign-in/sync UI وب، `idbStore.ts` (الگوی IDB) | قابل تطبیق [کد] |
| fixtureهای parity/yjs-compat | به‌عنوان بردار آزمون مهاجرت و پاریتی yrs↔yjs |

| بازنشسته شود | چرا |
|---|---|
| `sync/mod.rs` (۳٬۰۷۵)، `hub.rs`، `snapshot.rs`، `pages.rs`، `plan.rs`، `hold_deletes`، tombstones.json، conflict-file `pages/<id> (cloud).json`، سطل سینک، md5 سه‌طرفه | علّیت ندارد؛ heuristicها |
| `nevis-core`/`nevis-wasm`: `blockmerge.rs`، `db_merge.rs`، `kv_merge.rs`، `page_state.rs` (منطق) | جایگزین: Yjs + LWW در TS. **می‌توان `yrs` را فقط در ابزار مهاجرت نگه داشت.** |
| `websync/engine.ts` فعلی (موتور path-based) | جایگزین: موتور op-log |
| سه بازنمایی هر صفحه (JSON، `.bin`، projection) | یک بازنمایی ذخیره‌شده (Yjs state) + JSON مشتق فقط برای export/فهرست |

---

# پیوست: منابع (با تاریخ دسترسی 2026-11-20)

- Loro: https://github.com/loro-dev/loro · https://loro.dev/blog/v1.0 · https://www.loro.dev/changelog/v1.0.0-beta · https://github.com/loro-dev (loro-prosemirror)
- Automerge 3: https://automerge.org/blog/automerge-3/ · https://cdn.jsdelivr.net/npm/@automerge/prosemirror@0.2.0/README.md
- Yjs 14 / y-prosemirror: https://fosdem.org/schedule/event/8VKQXR-blocknote-yjs-prosemirror · https://www.blocknotejs.org/examples/collaboration/versioning-yjs14 · https://github.com/TypeCellOS/BlockNote/pull/2739 · https://socket.dev/npm/package/@tiptap/y-tiptap
- Yjs GC و snapshot (انجمن): https://discuss.yjs.dev/t/undo-manager-disables-gc-makes-doc-size-grow-unbounded/3797 · https://discuss.yjs.dev/t/handling-slow-mergeupdates-on-server/1105/3 · https://legendkeeper.com/changelog/legendkeeper-0-13-5-1
- cr-sqlite: https://github.com/vlcn-io/cr-sqlite
- PowerSync: https://www.powersync.com/blog/powersync-open-edition-release · https://docs.powersync.com/resources/feature-status.md · https://powersync.com/blog/sqlite-persistence-on-the-web
- Electric: https://electric-sql.com/blog/2025/03/17/electricsql-1.0-released
- Zero: https://infoq.com/news/2026/06/zero-version-1 · https://zero.rocicorp.dev/docs/self-host
- Replicache: https://forums.basehub.com/rocicorp/mono/1
- Triplit: https://supabase.com/blog/triplit-joins-supabase
- WebKit storage: https://webkit.org/blog/14403/updates-to-storage-policy/
- SQLite WASM: https://sqlite.org/wasm/doc/trunk/persistence.md (واکشی ۵۰۳) · https://sqlite.org/forum/forumpost/449ae66eb1 · https://github.com/powersync-ja/powersync-js/issues/785
- Logseq: https://github.com/logseq/logseq/ · https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020
- SiYuan: https://github.com/siyuan-note/siyuan
- Joplin: https://joplinapp.org/help/dev/spec/sync/
- Standard Notes: https://standardnotes.com/help/security/encryption
- Anytype: https://doc.anytype.io/anytype/data/privacy-and-encryption · https://pkg.go.dev/github.com/anyproto/any-sync · https://codeberg.org/Safecast/AnyType-VPS
- AFFiNE: https://deepwiki.com/toeverything/AFFiNE/4.2-document-processing-and-y-octo-crdt · https://docs.affine.pro/self-host-affine
- AppFlowy: https://docs.appflowy.io/docs/documentation/appflowy-cloud/architecture
- مخزن: `docs/adr/0001..0004, 0007`، `server/README.md`، `spike/tiptap/src-tauri/src/mcp.rs`، `spike/tiptap/src-tauri/nevis-core/`.
