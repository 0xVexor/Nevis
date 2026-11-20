# R4: سرور همگام‌سازی و پروتکل‌ها برای Nevis

تاریخ تحقیق: 2026-11-20. برچسب‌ها: [source] = منبع اولیه (مخزن، مستندات، صفحه رسمی) که خودم باز کرده‌ام؛ [secondary] = وبلاگ، آینه، جستجو یا مقایسه‌ی شخص ثالث؛ [inference] = استنتاج من. جایی که نتوانستم تأیید کنم، صریحاً نوشته‌ام.

## معنای این برای تصمیم ما

- یک سرور Yjs خودمیزبان و بالغ با مدل «لاگ عملیات + sequence» وجود دارد، اما بیشتر آنها مدل «به‌روزرسانی Yjs + ذخیره‌ی سند» هستند، نه لاگ عملیات عمومی. [source: y-sweet، Hocuspocus]
- y-sweet با MIT و ذخیره‌سازی روی فایل یا S3-compatible و توکن کلاینت برای دسترسی سند‌محور است. [source: github.com/jamsocket/y-sweet، تاریخ صفحه مشخص نیست]
- Hocuspocus ذخیره را با هوک `onStoreDocument` (نسخه‌ی debounce شده‌ی onChange) انجام می‌دهد و بدون افزونه‌ی ذخیره‌سازی، با ری‌استارت سند از دست می‌رود. [source: tiptap.dev/docs/hocuspocus/guides/persistence، بدون تاریخ]
- برای چند نمونه‌ی Hocuspocus، Redis برای هماهنگی لازم است؛ این را فقط از نتیجه‌ی جستجو دارم. [secondary]
- پیاده‌سازی‌های Go پروتکل Yjs وجود دارند (reearth/ygo، Deln0r/ygo، CivNode/yjs-go)، اما همه third-party هستند و بلوغ‌شان را تأیید نکرده‌ام. [secondary]
- Replicache در وضعیت maintenance است و Rocicorp توسعه‌ی فعال را به Zero منتقل کرده؛ وضعیت Zero (alpha/1.0) در منابع متناقض است. [secondary]
- PowerSync Open Edition با FSL منتشر شده و خودش «beta» خوانده شده؛ SDKها Apache-2.0 هستند. [source: powersync.com/legal، docs.powersync.com/intro/self-hosting، تاریخ مشخص نیست]
- Actual Budget از HLC برای timestamp پیام‌های CRDT و Merkle برای تشخیص اختلاف استفاده می‌کند؛ این را از توضیح‌های معماری و مثال‌های ثانویه دارم، نه از کد. [secondary]
- Linear از «sync ID» و delta packet استفاده می‌کند؛ منبع اصلی آن صحبت‌ها و مخزن reverse-engineering است. [secondary]
- Keyhive (Ink & Switch) در pre-alpha است؛ کد در 2025-03-10 منتشر شد و هشدار داده شده «از این نسخه در production استفاده نکنید» و هیچ audit امنیتی انجام نشده. [source: inkandswitch.com/keyhive/notebook/04]
- در Keyhive، سرور Beelay فقط ciphertext را می‌بیند، اما metadata مانند heads گراف commit و بخشی از membership را می‌بیند. [source: keyhive notebook]
- برای ما: payload باید opaque بماند؛ metadata سرور (workspace، op_id، seq، زمان، نوع سند، و اعضا) باید قبل از E2EE تعریف شود. [inference]
- هیچ‌کدام از منابع نشان نداد که پیاده‌سازی HLC یا drift bound آن را تأیید کند؛ PDF مقاله 404 داد. [بخش ندانسته‌ها]

## 1. سرورهای Yjs خودمیزبان

| پروژه | زبان/وضعیت | مدل ذخیره | Auth / hook | مقیاس و نکات | لایسنس | منبع و تاریخ |
|---|---|---|---|---|---|---|
| y-sweet (jamsocket) | Rust؛ تعداد issue باز 23 و 5 PR (بک‌لاگ فعال) | «داده‌ی سند» روی S3-compatible یا مسیر فایل؛ جزئیات update در مقابل snapshot تأیید نشد | توکن کلاینت صادرشده توسط backend شما؛ Jamsocket سرویس managed هم دارد | horizontal scaling با مدل session backend [secondary] | MIT [source] | github.com/jamsocket/y-sweet؛ docs.y-sweet.dev در دسترس نبود (ENOTFOUND) |
| Hocuspocus (Tiptap) | Node.js؛ وضعیت نگهداری: مستندات فعال (نسخه‌های 4.x در npm) | هوک‌های onLoadDocument/onStoreDocument؛ افزونه‌های Database، SQLite، S3 | onAuthenticate (از مستندات کلی؛ صفحه‌ی persistence آن را نگفت) | Redis برای چند instance [secondary]؛ مقدار پیش‌فرض debounce تأیید نشد | MIT [inference؛ باید در repo بررسی شود] | tiptap.dev/docs/hocuspocus/guides/persistence، بدون تاریخ |
| y-websocket | Node؛ پروتکل مرجع کلاینت/سرور Yjs | فایل/LevelDB در نمونه‌ها | ندارد مگر خودتان اضافه کنید | ساده، برای مقیاس بزرگ مناسب نیست [inference] | MIT [inference] | برای این تحقیق بررسی نشد |
| y-redis | Node + Redis | Redis streams + persistence | وابسته به پیاده‌سازی | برای scale افقی طراحی شده [inference] | — | برای این تحقیق بررسی نشد |
| Liveblocks self-host | تجاری؛ self-host محدود | — | — | — | تجاری | بررسی نشد |
| reearth/ygo | Go؛ پورت خالص Go از Yjs v13 | خودتان تعیین می‌کنید؛ core مستقل از transport | sync (SyncStep1/2/Update) و awareness | ادعای binary compatibility با Yjs مرجع [secondary] | بررسی نشد | pkg.go.dev/github.com/reearth/ygo |
| Deln0r/ygo | Go؛ WebSocket سازگار با Hocuspocus | خودتان | embed به صورت http.Handler | نسخه‌های 1.x تا 1.25 در pkg.go.dev [secondary] | بررسی نشد | github.com/Deln0r/ygo |
| CivNode/yjs-go | Go؛ alpha v0.1.x | relay | http.Handler | breaking change محتمل تا v1 [secondary] | بررسی نشد | pkg.go.dev/github.com/CivNode/yjs-go |

نکته: هیچ‌کدام از این‌ها مدل «لاگ عملیات عمومی با seq سرور» را ارائه نمی‌کنند؛ آنها «sync پروتکل Yjs» را حل می‌کنند. برای ما Yjs فقط یک نوع payload است و لاگ عملیات باید خودمان باشد. [inference]

## 2. سیستم‌های op-log و آنچه می‌آموزیم

| سیستم | مدل سرور | قانون تعارض | cursor | idempotency / GC | بلوغ و لایسنس | خودمیزبانی |
|---|---|---|---|---|---|---|
| Replicache | push endpoint + pull endpoint؛ mutators دوطرفه | سرور نتیجه‌ی قطعی؛ کلاینت پیش‌بینی می‌کند [secondary] | version cursor در pull [secondary] | mutation queue ارسال‌شده به push [secondary] | maintenance؛ آخرین commit در 2022-04 [secondary] | بله (مدل ساده) |
| Zero (Rocicorp) | zero-cache روی Postgres، partial sync | server reconciliation [source: zero.rocicorp.dev/docs/sync] | نسخه‌ی نامشخص | نامشخص | alpha یا 1.0 (منابع متناقض؛ InfoQ 2026-06 فقط عنوان دیده شد) [secondary] | نامشخص |
| PowerSync | Postgres/MongoDB/MySQL/SQL Server ← سرویس ← SQLite کلاینت [secondary] | upload queue سمت کلاینت [inference] | — | — | Open Edition بتا؛ FSL؛ SDK Apache-2.0 [source] | بله، Open Edition |
| Actual Budget | messages_crdt با timestamp از HLC؛ Merkle برای تطبیق | LWW بر اساس HLC [secondary] | Merkle + since timestamp | پیام‌ها تکراری نمی‌شوند؛ GC نامشخص | MIT؛ فعال [secondary] | بله |
| Linear | object pool؛ transaction queue در IndexedDB؛ delta packet با sync ID | ترتیب سرور [secondary] | lastSyncId | undo/redo با transaction معکوس | پیاده‌سازی بسته؛ مستندات از talk و reverse-engineering [secondary] | خیر |
| Standard Notes | ciphertext در MySQL؛ Redis برای session و throttling | نسخه‌ی item [secondary] | sync token (جزئیات تأیید نشد) | — | لایسنس AGPL از دانش من است و تأیید نشد؛ self-host با Docker/Railway [secondary] | بله |
| Keyhive/Beelay | ciphertext؛ metadata مثل commit heads | capability با CRDT و revocation [source] | تابع commit graph [source] | — | pre-alpha؛ بدون audit [source] | آزمایشی |
| Figma multiplayer | سرور مرکزی per-document؛ CRDT-like | تأیید نشد | — | — | بسته | خیر |
| Triplit، Jazz، Evolu، LiveStore، ElectricSQL، AFFiNE، Anytype، Notion | — | — | — | — | تأیید نشد؛ جزئیات این‌ها در این تحقیق بررسی نشد | — |

آموخته‌ها: pull با cursor عددی سرور، push با batch و idempotency با شناسه‌ی عملیات، و نگهداری تاریخچه با snapshot پایه‌ی تازه‌تر، الگوهای تکراری‌اند. [inference]

## 3. HLC، LWW و CRDT

- مقاله‌ی اصلی: Kulkarni، Demirbas، Madeppa، Avva، Leone، «Logical Physical Clocks» (2014). [secondary، از نتیجه‌ی جستجو]
- PDF در cse.buffalo.edu برای من 404 داد، پس قضیه‌ی drift bound و الگوریتم دقیق را از متن اصلی تأیید نکرده‌ام. [source failed]
- الگوریتم عمومی HLC (هر پیام: l = max(l, pt) و counter c؛ در دریافت هم مقایسه‌ی برچسب ماکسیمم) مطابق دانش عمومی من است و باید با PDF بررسی شود. [inference]
- drift: l تا فاصله‌ی ε از ساعت فیزیکی می‌ماند، که ε عدم قطعیت همگام‌سازی است. [secondary]
- pitfalls عملی [inference]:
  - ساعت کلاینت عقب یا جلو است: timestamp سرور را به عنوان مرجع نگه دارید و clock کلاینت را فقط برای ترتیب محلی استفاده کنید.
  - سرور باید آخرین HLC را پس از restart بازیابی کند تا به عقب برنگردد.
  - counter overflow را در یک بازه‌ی زمانی بررسی کنید.
  - ID تکرارشونده در timestamp هم‌زمان: tie-break با node/client ID.
- LWW register و tombstone: هر فیلد یک timestamp دارد؛ حذف یک tombstone با timestamp است تا تأخیر یا بازگشت یک update کهنه، رکورد را زنده نکند. [inference]
- add-wins set و remove-wins set نیازمند یادآوری دو دسته تگ (add tag و remove tag) هستند؛ مرجع کلاسیک Shapiro، Preguiça، Baquero، Zawirski، «Conflict-free Replicated Data Types» (SSS 2011، INRIA RR-7687). [inference: از دانش، PDF بررسی نشد]
- Kleppmann و همکاران، «Local-first software: you own your data, in spite of the cloud»، Onward! 2019، DOI 10.1145/3359591.3359737. [secondary؛ صفحه‌ی اصلی: inkandswitch.com/local-first]. اصول هفت‌گانه در منابع ثانویه فقط تا مورد چهارم دیده شد؛ Kleppmann بعدها گفت این هفت اصل تعریف دقیق نیستند. [secondary]

## 4. ابزار Go

| موضوع | یافته | برچسب |
|---|---|---|
| WebSocket | coder/websocket (قبلاً nhooyr) برای پروژه‌ی جدید توصیه شده؛ آخرین push در منبع 2025-03-25 دیده شد | [secondary] |
| WebSocket | gorilla/websocket بیشترین استفاده را دارد (42k+ importers)؛ وضعیت نگهداری 2026 تأیید نشد | [secondary] |
| SSE | برای presence یک‌طرفه کافی است؛ کد از نظر پیاده‌سازی ساده‌تر است | [inference] |
| SQLite driver | mattn (CGO، wrapper کد C) معمولاً سریع‌تر؛ modernc (ترجمه‌ی مکانیکی C به Go، بدون CGO) بین 10% تا 2 برابر کندتر در بنچ‌های مختلف | [secondary] |
| SQLite driver | یک گزارش ادعا کرده modernc در یک درخواست نوشتن را از دست می‌دهد؛ تأیید نشد | [secondary، ادعای نیازمند بررسی] |
| WAL | یک writer در هر لحظه؛ readers و writer هم‌زمان؛ WAL روی network filesystem کار نمی‌کند؛ checkpoint خودکار حدود 1000 page | [source: sqlite.org/wal.html] |
| WAL | برای سرور با یک process، locking_mode=EXCLUSIVE از shm صرف‌نظر می‌کند | [source] |
| Backup | Litestream: صفحه‌ی GitHub در دسترس نبود (404)؛ نسخه‌ی فعلی و مدل replication تأیید نشد | ندانسته |
| Request limits | از http.MaxBytesReader، timeouts سرور و محدودیت batch در سطح اپ استفاده کنید | [inference] |

الگوی پیشنهادی برای idempotent batch با seq یکنواخت [inference]:
- جدول `ops(workspace_id, op_id, seq, envelope, created_at)` با `UNIQUE(workspace_id, op_id)`.
- یک writer goroutine یا `BEGIN IMMEDIATE` برای هر batch؛ seq از یک جدول counter یا `MAX(seq)+1` داخل همان transaction.
- در درج، `INSERT OR IGNORE` و برگرداندن seq موجود برای op_id تکراری.
- batch به صورت transaction اتمی؛ پاسخ شامل map از op_id به seq.

## 5. Auth و session

| گزینه | تهدید اصلی | یادداشت | برچسب |
|---|---|---|---|
| bearer در IndexedDB یا localStorage | هر اسکریپت XSS می‌تواند توکن را بخواند | OWASP از ذخیره‌ی توکن حساس در Web Storage نهی می‌کند | [secondary: OWASP cheat sheet؛ نسخه‌ی کامل بررسی نشد] |
| cookie httpOnly + SameSite + CSRF token | CSRF؛ XSS می‌تواند دور بزند | برای same-site کافی‌تر است | [secondary] |
| access token در حافظه + refresh در cookie | سرقت access محدود به زمان حیات آن | الگوی رایج؛ نیازمند rotation | [secondary] |
| device registration + rotation | سرقت refresh token | هر device یک session مستقل | [inference] |
| WebAuthn/passkeys | phishing-resistant | برای login؛ نه برای هر درخواست sync | [inference]، پیاده‌سازی بررسی نشد |

rate limit برای login و push باید per-IP و per-account باشد. [inference]

## 6. دسترسی per-document با payload opaque

| سیستم | مدل | سرور چه می‌بیند | برچسب |
|---|---|---|---|
| Keyhive/Beelay | convergent capabilities با Admin/Edit/Read/Relay؛ revocation امضاشده | ciphertext، commit heads، بخشی از membership، audience و timestamp پیام | [source: keyhive notebook 04، 05، 06] |
| Matrix | Megolm session key به‌صورت per-device با Olm؛ power levels و join rules به‌صورت state event قابل‌دیدن سرور | رویدادهای state (power levels، join rules)، لیست اعضا، زمان | [secondary: Element proposal و eprint 2023] |
| Standard Notes | payload رمزشده روی سرور | ciphertext، حساب، session | [secondary] |
| Notion | غیر E2EE | همه‌چیز | [inference؛ بررسی نشد] |

حداقل metadata که سرور لازم دارد: workspace_id، doc_id، کلاینت/device، op_id، seq، زمان دریافت، اندازه‌ی payload، و نقش کاربر برای اعمال authorization. اگر E2EE بیاید، membership باید به‌صورت signed و قابل‌تأیید کلاینت باشد. [inference]

## 7. Snapshot، compaction و حداقل نسخه‌ی کلاینت

- y-sweet و Hocuspocus سند را به‌صورت باینری ذخیره می‌کنند؛ نگهداری update خام یا snapshot در مستندات y-sweet تأیید نشد. [source/اعلام نشده]
- Hocuspocus هشدار می‌دهد ذخیره‌ی Y.Doc به‌صورت JSON و بازسازی باینری در connect می‌تواند merge را خراب کند و محتوا را تکرار کند. [source: tiptap.dev]
- الگوی log + snapshot: هر N عملیات یک snapshot با `base_seq` ذخیره کنید؛ کلاینت جدید از snapshot شروع کند، سپس از base_seq+1 بکشد؛ عملیات قبل از base_seq فقط پس از تأیید همه‌ی کلاینت‌های فعال حذف شوند. [inference]
- حداقل نسخه‌ی کلاینت: هدر `min_protocol_version` در هر پاسخ؛ کلاینت قدیمی‌تر باید حالت read-only یا اجبار به update بگیرد. [inference؛ الگوی Replicache/Zero بررسی نشد]

## ندانسته‌ها

- docs.y-sweet.dev قابل دسترس نبود (ENOTFOUND)؛ مدل update خام یا snapshot در y-sweet تأیید نشد.
- مقالات HLC (buffalo.edu PDF) 404 دادند؛ drift bound و الگوریتم دقیق از منبع اولیه تأیید نشد.
- Litestream در GitHub 404 داد؛ نسخه و مدل replication آن تأیید نشد.
- وضعیت Zero (alpha یا 1.0) متناقض است؛ زمان InfoQ را فقط از عنوان دیدم.
- Hocuspocus: مقدار پیش‌فرض debounce و جزئیات multi-instance تأیید نشد.
- y-websocket، y-redis، Liveblocks، Triplit، Jazz، Evolu، LiveStore، ElectricSQL، AFFiNE، Anytype و مدل Figma بررسی نشدند.
- Standard Notes: sync token و الگوی cursor تأیید نشد.
- Linear: معماری از منابع ثانویه و reverse-engineering است، نه سند رسمی.
- WebAuthn و مستندات OWASP کامل بررسی نشدند؛ خلاصه‌ها از نتایج جستجو هستند.
- ادعای باگ در modernc (نوشتن از دست‌رفته) تأیید نشد.
- Matrix: سند server-blind permissions در 2025 پیدا نشد؛ جزئیات از Element proposal و eprint 2023 است.
- هیچ benchmark دقیق 2025 برای mattn در برابر modernc پیدا نشد.
- لایسنس‌های reearth/ygo، Deln0r/ygo و CivNode/yjs-go بررسی نشد.
- برای Keyhive، سند کامل ناتمام بود (بخش 100000 کاراکتر از 112006)؛ بخش‌های آخر، شامل Rain diagrams 2026-11-11، بررسی نشد.
- تمام تاریخ‌های نسخه‌ها و commitها از صفحات ثانویه یا snapshot جستجو هستند و ممکن است قدیمی باشند.
