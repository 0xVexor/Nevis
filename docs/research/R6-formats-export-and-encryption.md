# R6: فرمت‌های export/import، باندل بدون اتلاف، آینه‌ی Markdown، E2EE، نسخه‌گذاری و ID

تاریخ دسترسی: 2026-11-20 · نوع: پژوهش (بدون توصیه) · گزارش قبلی `storage-and-sync-options.md` خوانده شد؛ ادعاهای ضعیف آن در بخش «بررسی گزارش قبلی» بررسی شده‌اند.

برچسب‌ها: **[source]** = صفحه‌ی رسمی/مشخصات/مخزن، با URL و تاریخ دسترسی؛ **[secondary]** = وبلاگ، انجمن، خلاصه‌ی جست‌وجو یا آینه‌ی مستندات؛ **[inference]** = نتیجه‌گیری من از شواهد.

---

## معنای این برای تصمیم ما

- Obsidian Sync: AES-256-GCM با کلید مشتق از scrypt و salt؛ مسیر رمزشده، زمان آپلود و دستگاه آپلودکننده روی سرور دیده می‌شوند. **[source]** https://obsidian.md/help/sync/security
- Standard Notes نسخه‌ی 004: Argon2id (64 MiB، ۵ تکرار، موازی ۱) و XChaCha20-Poly1305؛ payload به شکل `004:nonce:ciphertext:AD`؛ سلسله‌مراتب root key ← items key. **[source، کپی‌ی مشخصات در صفحه‌ی راهنما، دسترسی ۲۰۲۶-۱۱-۲۰]** https://standardnotes.com/help/security/encryption
- Notesnook: هر آیتم جدا با XChaCha20-Poly1305-IETF رمز می‌شود؛ کلید اصلی از رمز با Argon2i؛ سرور فقط متن رمزشده و nonce ۱۹۲ بیتی را ذخیره می‌کند. **[source]** https://notesnook.com/help/how-is-my-data-encrypted
- Joplin: مشخصات native E2EE می‌گوید AES-256-GCM با IV ۹۶ بیتی و tag ۱۲۸ بیتی؛ master key با PBKDF2-HMAC-SHA512 (۲۲۰٬۰۰۰ تکرار) پوشانده می‌شود. یک منبع ثانویه XChaCha20 می‌گوید؛ **تناقض حل نشد.** **[source + secondary]** https://joplinapp.org/help/dev/spec/e2ee/native_encryption
- Bitwarden: AES-CBC-256 با HMAC؛ KDF از PBKDF2-SHA256 یا Argon2id؛ کلیدها در کلاینت ساخته می‌شوند. **[source برای صفحه‌ی راهنما/whitepaper؛ جزئیات hierarchy از mirror ثانویه]** https://bitwarden.com/help/what-encryption-is-used/
- WebCrypto `deriveKey` در MDN نه Argon2 و نه XChaCha20-Poly1305 را دارد؛ HKDF، PBKDF2، ECDH/X25519 و AES-GCM را دارد. libsodium.js (ISC) XChaCha20-Poly1305 و X25519 دارد؛ Argon2 فقط در build sumo است. **[source]** https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey ، https://github.com/jedisct1/libsodium.js
- `showDirectoryPicker` در MDN «limited availability» است، نیاز به secure context و user activation دارد. Firefox و Safari وضعیت منفی دارند. **[source برای MDN؛ secondary برای وضعیت مرورگرها]** https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker ، https://web-platform-dx.github.io/web-features-explorer/features/file-system-access
- RFC 9562 (مه ۲۰۲۴): UUIDv7 با timestamp ۴۸ بیتی ms در ابتدای ID؛ مرتب‌سازی به monotonicity وابسته است (§6.2). **[source]** https://rfc-editor.org/rfc/rfc9562.html
- Anytype: export به Markdown، relation و URL بوک‌مارک را از دست می‌دهد؛ گزارش‌ها از ۲۰۲۴–۲۰۲۵ است. **[secondary]** https://community.anytype.io/t/concerns-about-the-current-allegedly-severe-limitations-of-the-export-function/25258
- Yjs `clientID` در انجمن رسمی «۳۲ بیت تصادفی به‌ازای session» توصیف شده؛ docs رسمی درباره‌ی تولید آن چیزی نمی‌گوید. **[secondary]** https://discuss.yjs.dev/t/globally-unique-client-id/312
- Notion: یادداشت‌های غیر-پایگاه‌داده به Markdown می‌روند، callout به HTML و پایگاه‌داده به CSV تخت. صفحه‌ی رسمی راهنما باز نشد. **[secondary]**
- Skiff (ابزار سند رمزشده) در ۲۰۲۴ توسط Notion خریده و محصولاتش بسته شد؛ تاریخ‌ها بین منابع متفاوت است. **[secondary]** https://en.wikipedia.org/wiki/Skiff_(email_service)

---

## ۱) فرمت‌های export/import و اتلاف

### ۱-الف) استانداردها و قراردادها

| فرمت | نگه می‌دارد | اتلاف برای ویژگی‌های ما |
|---|---|---|
| CommonMark | سرفصل، لیست، کد، لینک، تصویر | همه‌ی ویژگی‌های سفارشی (جهت متن، callout، toggle، ستون، id بلوک، ریاضی، mermaid، نقاشی، دیتابیس) **[source]** |
| GFM | + جدول ساده، task list، strikethrough | جدول با merged cell و بلوک داخل سلول **[secondary]** |
| YAML front-matter | متادیتای سند | قرارداد جهانی نیست؛ Obsidian، Jekyll، Hugo از آن استفاده می‌کنند **[inference]** |
| Wikilinks `[[عنوان]]` | لینک داخلی بر اساس نام | ابهام نام و نبود شناسه‌ی پایدار؛ برای بلوک‌ها `^id` یا نگاشت لازم است **[inference]** |
| Obsidian callout | `> [!note]`، fold با `+`/`-` | مخصوص Obsidian **[source]** |
| Pandoc AST (JSON) | ساختار درختی با نسخه‌ی API | فهرست extensionها و نسخه‌ی JSON در این جلسه خوانده نشد (ندانسته) |
| TextBundle v2 | `info.json` با `version`، `text.*`، `assets/` | متن + پیوست؛ ساختار بلوکی و متادیتای بلوک ندارد **[source]** https://textbundle.org/spec/ |
| OPML | درخت گره‌ها با متن | بدون نوع بلوک، جدول، پیوست و ویژگی **[inference]؛ مشخصات OPML خوانده نشد** |
| ProseMirror JSON | کامل، اگر schema همراه باشد | وابسته به نسخه‌ی schema (بخش ۵) **[source]** |

### ۱-ب) روش محصولات (round trip)

| محصول | خروجی | round trip / اتلاف | منبع |
|---|---|---|---|
| Obsidian | پوشه‌ی `.md` + YAML، wikilinks، callout، `^id` | خوب در Obsidian؛ callout و `^id` خارج از آن کم‌پشتیبان | [source] |
| Logseq (OG) | `.md`/`.org` با outline | بلوک با ویژگی `id::`؛ نسخه‌ی DB منبع حقیقت SQLite است | [secondary] |
| Notion | Markdown & CSV | callout به HTML؛ DB تخت؛ relation به UUID؛ toggle wrapper و view از دست می‌رود (گزارش) | [secondary] |
| AppFlowy | Markdown/HTML/TXT per doc؛ DB به CSV؛ ZIP کل workspace (از v0.9.7، گزارش) | ساختار ZIP تأیید نشد | [secondary] |
| SiYuan | `.sy` (JSON درخت بلاک)، `.sy.zip`، Markdown | محتوای `.sy.zip` تأیید نشد | [secondary] |
| Anytype | Markdown؛ Protobuf/JSON (Any-Block) | Markdown: relation، URL بوک‌مارک و سلسله‌مراتب از دست؛ LaTeX خراب (گزارش) | [secondary] |
| Bear، AFFiNE | — | تحقیق نشد یا فقط از آینه‌ی DeepWiki (AFFiNE) | ندانسته |

### ۱-ج) جدول اتلاف برای ویژگی‌های ما

| ویژگی | GFM | Obsidian | Notion MD&CSV (گزارش) | Anytype MD (گزارش) | JSON (ProseMirror) |
|---|---|---|---|---|---|
| جهت متن per-block | از دست؛ مگر HTML `<div dir>` | از دست | نامعلوم | نامعلوم | بدون اتلاف |
| callout | از دست | نزدیک‌ترین | HTML | نامعلوم | بدون اتلاف |
| toggle | `<details>` | ندارد | محتوا می‌ماند، wrapper نه | نامعلوم | بدون اتلاف |
| جدول merged cell | HTML یا از دست | از دست | نامعلوم | نامعلوم | بدون اتلاف |
| ستون (layout) | از دست | از دست | نامعلوم | نامعلوم | بدون اتلاف |
| block id | از دست | `^id` | نامعلوم | از دست | بدون اتلاف |
| ریاضی | `$..$` بسته به renderer | `$..$` | نامعلوم | LaTeX خراب | بدون اتلاف |
| mermaid | fenced block | fenced block | نامعلوم | نامعلوم | بدون اتلاف |
| نقاشی | تصویر (ویرایش‌پذیری از دست) | همین | نامعلوم | نامعلوم | نیاز به JSON + تصویر |
| database view | تخت (CSV) | فایل جدا یا از دست | تخت، view از دست | relation از دست | schema + rows + view |

**[inference]** ستون‌های «گزارش» از خلاصه‌ی منابع ثانویه است؛ هیچ export واقعی تست نشد.

---

## ۲) باندل بدون اتلاف

### ۲-الف) prior art

| نمونه | ساختار | آنچه قابل‌الگو است | منبع |
|---|---|---|---|
| EPUB OCF | ZIP؛ `mimetype` اولین entry، بدون فشرده‌سازی، محتوی `application/epub+zip`؛ `META-INF/container.xml` الزامی | نوع فایل با مقدار ثابت در ابتدای ZIP | [source] W3C EPUB 3.2 §4.3 https://www.w3.org/publishing/epub32/epub-ocf.html |
| TextBundle v2 | `info.json` با `version` و `type`؛ `text.*`؛ `assets/` با مسیر نسبی | نسخه‌ی صریح در متادیتا؛ پیوست نسبی | [source] |
| .docx (OPC) | ZIP با `[Content_Types].xml` و روابط | مدل content-types + relationships | [inference]؛ مشخصات OPC خوانده نشد |
| Joplin JEX/RAW | RAW: یک فایل per item با متادیتا | یک فایل per entity برای diff | ندانسته (ادعای tar بدون منبع حذف شد) |
| Obsidian vault | پوشه‌ی فایل‌های معمولی + `.obsidian/` | خواندنی بدون ابزار؛ تاریخچه و شناسه ندارد | [inference] |
| SiYuan `.sy.zip` | JSON per سند + notebook | نزدیک‌ترین مثال؛ محتوای دقیق تأیید نشد | [secondary] |
| Anytype export | ZIP با JSON/Protobuf | کامل ولی غیرقابل خواندن برای انسان | [secondary] |

### ۲-ب) گزینه‌های چیدمان

| گزینه | مزیت | هزینه |
|---|---|---|
| (الف) `manifest.json` + `pages/*.json` (ProseMirror) + `attachments/<sha256>.<ext>` | ساده، diff‌پذیر، شناسه‌ی پایدار | نیاز به schema version در manifest |
| (ب) یک فایل SQLite (dump) | یک فایل، کوئری | مرجع دوم داده؛ کمتر قابل خواندن |
| (پ) مثل (الف) + op log | تاریخچه‌ی کامل و بازپخش | حجم بیشتر؛ وابسته به نسخه‌ی op |

**Checksum:** SHA-256 برای نام پیوست (content addressing) و فهرست checksum در manifest **[inference]**. **امضای باندل** (مثلاً Ed25519 یا minisign) تحقیق نشد.

### ۲-ج) streaming در مرورگر

- **fflate:** کلاس `Zip` با `ondata` خروجی را استریم می‌کند؛ `ZipPassThrough` بدون فشرده‌سازی است؛ `AsyncZipDeflate` ناهمگام است؛ ZIP64 ذکر نشده **[source]** https://github.com/101arrowz/fflate (ادعای اندازه‌ی ~8kB از نویسنده است).
- **File System Access:** نوشتن استریمی روی دیسک فقط در Chromium؛ در غیر این صورت دانلود Blob (حافظه‌ی زیاد برای workspace بزرگ) **[inference]**.
- **zip.js:** تحقیق نشد.

---

## ۳) آینه‌ی یک‌طرفه‌ی Markdown

| مسیر | وضعیت | واقع‌گرایی |
|---|---|---|
| وب، Chromium/Edge | `showDirectoryPicker` با HTTPS و user activation **[source MDN]** | ممکن؛ دسترسی در هر session باید دوباره تأیید شود **[inference]** |
| وب، Firefox/Safari | وضعیت منفی **[secondary]** | ممکن نیست؛ فقط دانلود ZIP یا export دستی **[inference]** |
| دسکتاپ (Tauri fs) | دسترسی به پوشه‌ی انتخاب‌شده با مجوز سیستم عامل | روی همه‌ی OS؛ جزئیات Tauri تأیید نشد **[inference]** |

**گزینه‌های طراحی یک‌طرفه (الگوهای رایج):** نام فایل بر پایه‌ی `id` نه عنوان (در Obsidian و Logseq، تغییر نام فایل اغلب شکست لینک می‌سازد) **[inference]**؛ front-matter با `id`؛ نوشتن atomic با temp + rename **[inference]**؛ ویرایش خارجی تعارض می‌سازد که باید آشکار شود **[inference]**.

---

## ۴) رمزنگاری انتها-به-انتها (E2EE)

### ۴-الف) محصولات

| محصول | رمز و KDF | بیرون از رمز (روی سرور) | بازیابی |
|---|---|---|---|
| Standard Notes 004 | Argon2id؛ XChaCha20-Poly1305؛ AD شامل `u`، `v`، `kp` **[source]** | ایمیل، salt seed، نسخه، `items_key_id`، UUID آیتم، `serverPassword` **[source]** | — |
| Obsidian Sync | scrypt + salt، HKDF، AES-256-GCM **[source]** | دستگاه، زمان آپلود، نگاشت مسیر رمزشده ↔ محتوا **[source]** | رمز گم‌شده قابل بازیابی نیست **[source]** |
| Notesnook | Argon2i؛ XChaCha20-Poly1305-IETF per item؛ data key زیر master key **[source]** | متن رمزشده، nonce، salt، alg ID، item ID؛ بقیه‌ی متادیتا نامعلوم | نامعلوم |
| Joplin | AES-256-GCM (مشخصات) با PBKDF2-SHA512 برای master key **[source؛ تناقض با XChaCha20 در منبع ثانویه]** | نامعلوم | تغییر رمز در انجمن بحث شده **[secondary]** |
| Bitwarden | AES-CBC-256 + HMAC؛ PBKDF2-SHA256 یا Argon2id؛ کلید کاربر ۵۱۲ بیتی زیر master key **[source برای الگوریتم؛ secondary برای hierarchy]** | — | — |
| Proton Drive | کلید اشتراک و کلید گره؛ هر passphrase با کلید آدرس کاربر امضا می‌شود تا سرور نتواند درخت را جعل کند **[secondary، وبلاگ رسمی Proton]** https://proton.me/blog/protondrive-security | نام‌ها و ساختار درخت رمزشده، ولی ساختار کامل نامعلوم | — |
| Skiff | کلید عمومی؛ برای Skiff Pages **[secondary]** | — | محصول بسته شده؛ تاریخ‌ها ناسازگار (۹ اوت ۲۰۲۴ یا ۱۲ ماه) |
| Anytype | رمز از recovery phrase **[secondary، از گزارش قبلی؛ صفحه باز نشد]** | — | — |

### ۴-ب) primitiveها و کتابخانه‌ها

| کار | گزینه | وضعیت مرورگر |
|---|---|---|
| KDF رمز | Argon2id (SN، Bitwarden، Notesnook از Argon2i) | WebCrypto ندارد؛ libsodium.js با sumo **[source]** |
| KDF کلید بازیابی | HKDF یا PBKDF2 | WebCrypto دارد **[source]** |
| سیفر | XChaCha20-Poly1305 (nonce ۱۹۲ بیتی؛ مناسب nonce تصادفی) | libsodium.js **[source]** |
| سیفر جایگزین | AES-256-GCM (nonce ۹۶ بیتی؛ محدودیت تعداد پیام با یک کلید) | WebCrypto **[source MDN]**؛ محدودیت تعداد پیام **[inference]** |
| توافق کلید | X25519 | WebCrypto (ECDH/X25519) **[source]**؛ پشتیبانی Safari/iOS تأیید نشد |

### ۴-ج) سلسله‌مراتب کلید (نمونه‌ها)

- **Data key تصادفی** برای داده؛ زیر master key یا kek پوشانده می‌شود (Notesnook، SN). **[source]**
- **Master key** از رمز مشتق می‌شود؛ تغییر رمز فقط data key را دوباره می‌پوشاند (Notesnook). **[source]**
- **Per-item key** (SN: `item_key` زیر items key). **[source]**
- **Share key و node key** (Proton): هر اشتراک و گره کلید دارد؛ passphrase زیر کلید والد. **[secondary]**
- **Recovery phrase/key:** گم شدنش یعنی از دست رفتن داده (Obsidian؛ SN). **[source]**
- **چرخش کلید پس از حذف عضو:** در مشخصات SN و Notesnook الگوی rotation هنگام حذف عضو پیدا نشد **(ندانسته)**. نمونه‌ی Proton شامل امضای passphrase با کلید آدرس است **[secondary]**.

### ۴-د) آنچه با E2EE می‌شکند

| قابلیت | وضعیت | منبع |
|---|---|---|
| جست‌وجوی سرور | می‌شکند؛ جست‌وجوی کلاینتی لازم است | [inference] |
| compaction سمت سرور (Yjs) | می‌شکند؛ کلاینت باید انجام دهد | [inference] |
| AI سمت سرور | ناممکن؛ فقط در کلاینت یا با متن رمزگشایی‌شده | [inference] |
| اشتراک با لینک | کلید باید در fragment یا کانال جدا باشد | [inference] |
| GC پیوست | فقط بر HMAC/هش کار می‌کند؛ هش خام محتوا را لو می‌دهد | [inference] |

### ۴-هـ) فیلدهای روز اول (فهرست و محصولی که هر کدام را دارد)

| فیلد | محصول نمونه | کاربرد |
|---|---|---|
| نسخه‌ی پروتکل/envelope | SN (`004:` در payload؛ `v` در AD) | مهاجرت بدون شکستن کلاینت قدیمی **[source]** |
| nonce صریح | SN (nonce در payload)، Notesnook (nonce ۱۹۲ بیتی) | **[source]** |
| شناسه‌ی کلید (`items_key_id`، `kid`) | SN **[source]** | چرخش و انتخاب کلید |
| AD شامل شناسه‌ی آیتم و نسخه | SN (`u`، `v`، `kp`) **[source]** | جلوگیری از جابه‌جایی payload بین آیتم‌ها |
| alg ID | Notesnook **[source]** | انتخاب سیفر در آینده |

ترکیب پیشنهادی با نام‌های ما کنار این جدول قرار نگرفت؛ این فهرست فقط شواهد است.

---

## ۵) نسخه‌گذاری schema و داده‌ی long-lived

| روش | یافته | منبع |
|---|---|---|
| ProseMirror | attrs با default؛ `nodeFromJSON`؛ `check`/`createChecked`؛ **رفتار node ناشناخته در راهنما نیست** | [source] https://prosemirror.net/docs/guide/#schema |
| Yjs | docs رسمی الگوی schema-in-doc ندارد؛ ترکیب جهانی از انواع ناشناخته وجود ندارد | [inference] |
| Cambria (lens) | تبدیل دوطرفه‌ی داده بین schemaها؛ مقاله‌ی ۲۰۲۱، DOI 10.1145/3447865.3457963 | [source/secondary] https://inkandswitch.com/cambria |
| Kleppmann و Cambria | در نتایج جست‌وجو تأیید نشد | ندانسته |
| Standard Notes | نسخه‌ی پروتکل در آیتم؛ مهاجرت از 003 | [source] |
| Yjs 13 به 14 | Yjs 14 پیش‌انتشار؛ گزارش قبلی گفته بود | [secondary، از گزارش قبلی؛ دوباره تأیید نشد] |

**الگوی کلاینت قدیمی:** Standard Notes نسخه‌ی پروتکل را در هر آیتم دارد و کلاینت باید آن را بشناسد **[source]**. اینکه y-prosemirror با node ناشناخته چه می‌کند **تأیید نشد** (ندانسته).

---

## ۶) ID: UUIDv7، ULID، KSUID، nanoid

| شناسه | ساختار | مرتب‌سازی | زمان ساخت لو می‌رود؟ | منبع |
|---|---|---|---|---|
| UUIDv7 | ۴۸ بیت ms + random/counter؛ ۱۲۸ بیت | monotonicity §6.2؛ rollback ساعت مشخص نیست | بله؛ «سیگنال ترتیب ساخت» (§8) | [source] RFC 9562 |
| ULID | ۴۸ بیت ms + ۸۰ بیت تصادفی؛ Crockford base32 (۲۶ کاراکتر) | در یک ms نیاز به monotonic generator | بله؛ ۱۰ کاراکتر اول | [source] https://github.com/ulid/spec |
| KSUID | ۳۲ بیت ثانیه (epoch 2014-05-13) + ۱۲۸ بیت payload؛ base62 (۲۷ کاراکتر) | بر پایه‌ی زمان ثانیه‌ای | بله؛ ثانیه | [source] https://github.com/segmentio/ksuid |
| nanoid | ۲۱ کاراکتر، ~۱۲۶ بیت تصادفی، الفبای ۶۴ تایی | ندارد (صریحاً ذکر نشده) | خیر | [source] https://github.com/ai/nanoid |

**Yjs clientID:** ۳۲ بیت تصادفی؛ احتمال برخورد دو تا ~۱ در ۴ میلیارد و birthday ~۲^۱۶ **[secondary]**. برخورد باعث بازتخصیص می‌شود، ولی عملیات همزمان دو کلاینت با یک ID مشکل می‌سازد **[secondary]**. docs رسمی درباره‌ی تولید آن ساکت است **[source]** https://docs.yjs.dev/api/y.doc.

**نشت زمان:** UUIDv7/ULID/KSUID زمان ساخت را از روی ID می‌خوانند؛ nanoid نه. برای E2EE، ID مبتنی بر زمان اطلاعات ساخت محتوا را آشکار می‌کند **[inference]**.

---

## بررسی گزارش قبلی (ادعاهای ضعیف)

| ادعای قبلی | وضعیت امروز |
|---|---|
| Logseq DB beta در ۲۰۲۶-۰۷-۱۳ | ناسازگار: منبع دیگر ۲.۰.۲ در ۲۰۲۶-۱۰-۰۷ را می‌دهد؛ تاریخ قطعی نیست **[secondary]** |
| Obsidian: مهاجرت نسخه‌ی رمز «حذف دائمی» | تأیید نشد: صفحه‌ی راهنما و صفحه‌ی blog فقط گفتند نسخه‌ی قدیمی از کلید پایه مستقیم استفاده می‌کند؛ حذف دائمی نیامد **[source]** |
| AES-256-GCM با WebCrypto | ممکن است؛ ولی Argon2id و XChaCha20 در WebCrypto نیستند **[source]** |
| SN 004 Argon2id | عدد ۶۴ MiB/۵/۱ از صفحه‌ی راهنما است؛ مخزن spec پیدا نشد **[source]** |
| y-prosemirror و node ناشناخته | تأیید نشد؛ ProseMirror guide این را نمی‌گوید **(ندانسته)** |
| AFFiNE compaction سمت سرور | همچنان فقط از DeepWiki **[secondary]** |
| SiYuan `.sy` JSON per سند و دیسک شخص‌ثالث | `.sy` JSON تأیید نشد؛ اخطار خرابی دیسک شخص‌ثالث تأیید نشد **[secondary]** |

---

## ندانسته‌ها

- صفحه‌ی رسمی Notion export باز نشد (ریدایرکت و ۴۰۴). ادعاهای Notion فقط از خلاصه‌ی جست‌وجو است.
- Bear، AFFiNE، AppFlowy، SiYuan: ساختار دقیق export و باندل تأیید نشد.
- Anytype: صفحه‌ی privacy باز نشد (ریدایرکت)؛ ادعای recovery phrase از گزارش قبلی است.
- Standard Notes: مخزن spec کامل و الگوی rotation پیدا نشد.
- Joplin: تناقض AES-256-GCM با XChaCha20 حل نشد.
- Proton: ساختار کامل درخت و الگوریتم‌ها از وبلاگ رسمی است، نه whitepaper؛ به‌روزی آن تأیید نشد.
- Skiff: تاریخ بسته شدن بین منابع ناسازگار است.
- RFC 9562: بخش privacy کامل خوانده نشد.
- File System Access: جدول MDN رندر نشد؛ وضعیت Safari 2026 تأیید نشد.
- Pandoc: فهرست extensionها و نسخه‌ی JSON AST خوانده نشد.
- JEX/RAW در Joplin: ساختار دقیق تأیید نشد.
- OPML، .docx OPC، zip.js، امضای باندل، Cambria/Kleppmann: تحقیق کافی نشد.
- Logseq: تاریخ‌های بتا ناسازگار.
- ستون‌های «گزارش» جدول اتلاف فقط از خلاصه‌ی منابع است؛ هیچ export تست نشد.
- هیچ تست واقعی روی Safari/iOS یا benchmark انجام نشد.
