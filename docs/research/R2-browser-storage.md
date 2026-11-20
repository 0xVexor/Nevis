# R2: ذخیره‌سازی مرورگر برای Nevis (وضعیت تا ۲۰۲۶-۱۱-۲۰)

برچسب‌ها: [source] = منبع اولیه (WebKit، MDN، sqlite.org، مخزن کد)، [secondary] = منبع ثانویه یا نتیجه جستجو، [inference] = استنتاج من. ادعاهایی که بدون منبع بازبینی‌شده‌اند، «تأیید نشده» نامیده شده‌اند.

## معنای این برای تصمیم ما

1. Safari (WebKit) سقف quota هر origin را برای برنامه‌های مرورگر حدود ۶۰٪ دیسک و برای سایر برنامه‌ها حدود ۱۵٪ اعلام کرده است [source: webkit.org/blog/14403، ۲۰۲۳-۰۸-۱۰].
2. سقف ۷ روزه ITP برای داده‌های قابل نوشتن توسط اسکریپت (IndexedDB، localStorage، OPFS و ...) در Safari مرورگری وجود دارد؛ WebKit برای وب‌اپ‌های Home Screen شمارنده جداگانه گفته است [source: webkit.org/blog/10218، ۲۰۲۰-۰۳-۲۴].
3. در ادعای سقف ۷ روزه، کوکی‌های سمت‌سرور معاف‌اند [source: MDN، صفحه quota].
4. `navigator.storage.persist()` در Safari به‌صورت heuristic تصمیم می‌گیرد؛ یکی از معیارهای ذکرشده در WebKit، باز شدن به‌عنوان Home Screen Web App است [source: webkit.org/blog/14403].
5. در Chrome و Edge حداکثر ۶۰٪ دیسک برای هر origin و ۸۰٪ کل است؛ persist بر اساس تعامل کاربر تأیید می‌شود [source: MDN].
6. Firefox برای persist از کاربر پرسش می‌کند [source: MDN].
7. OPFS sync access handle از Safari 15.2، Firefox 111 و Chrome 102 پشتیبانی می‌شود [secondary: caniuse، صفحه FileSystemSyncAccessHandle].
8. sqlite-wasm رسمی سه VFS مرتبط با OPFS دارد؛ `opfs` به COOP/COEP نیاز دارد، `opfs-sahpool` نیاز ندارد ولی هم‌زمانی چند تب را پشتیبانی نمی‌کند [source: sqlite.org/wasm/doc/trunk/persistence.md].
9. نسخه‌های قدیمی Safari (کمتر از ۱۷) با VFS مبتنی بر OPFS سازگار نیستند؛ این را SQLite به یک باگ WebKit بدون شناسهٔ مشخص نسبت داده است [source: همان صفحه].
10. Background Sync در Safari iOS پشتیبانی نمی‌شود [secondary: caniuse، جستجو].
11. Web Locks و BroadcastChannel در Safari 15.4+ هستند؛ پس leader election با Web Locks در هر سه موتور امکان‌پذیر است [secondary: caniuse].
12. [inference] برای ۱۰ هزار صفحه و چند صد مگابایت، سقف Safari iOS و تضمین‌نشدن persist، ریسک اصلی است. نیاز به outbox پایدار و توانایی بازسازی از سرور داریم.

## ۱. Safari، iOS و macOS

**quota و estimate.** WebKit در ۲۰۲۳-۰۸-۱۰ گفته است: سقف origin برای برنامه‌های مرورگر ۶۰٪ دیسک و برای سایرین ۱۵٪؛ سقف کل ۸۰٪ و ۲۰٪؛ frame بین‌مبدأ ۱۰٪ سقف والد. `estimate()` مقدار usage و quota را می‌دهد؛ quota سقف است نه تضمین [source: webkit.org/blog/14403]. MDN می‌گوید در نسخه‌های قدیمی‌تر Safari هر origin ابتدا ۱ GiB داشت و بعد از آن اجازهٔ کاربر لازم بود [source: MDN، صفحه quota، تاریخ تأیید‌نشده].

**سقف ۷ روزه (ITP).** WebKit در ۲۰۲۰-۰۳-۲۴ گفته است همهٔ داده‌های قابل نوشتن توسط اسکریپت یک وب‌سایت پس از ۷ روز استفاده از Safari بدون تعامل کاربر با آن سایت پاک می‌شود. فهرست: IndexedDB، LocalStorage، Media keys، SessionStorage، و ثبت Service Worker و cache [source: webkit.org/blog/10218]. MDN همین قاعده را به‌عنوان eviction «proactive» فقط برای Safari با cross-site tracking prevention روشن ذکر می‌کند [source: MDN]. **نکته:** پست ۲۰۲۳ WebKit دربارهٔ storage policy این سقف را ذکر نمی‌کند؛ پس وضعیت ۲۰۲۶ آن تأیید‌نشده است [inference از عدم ذکر در منبع ۲۰۲۳].

**Home Screen.** WebKit گفته وب‌اپ‌های Home Screen «counter روز استفادهٔ جداگانه» دارند و انتظار نمی‌رود داده‌های first-party آن‌ها پاک شود [source: webkit.org/blog/10218]. باگ WebKit شمارهٔ ۲۳۷۳۵۰ (۲۰۲۲) نشان می‌دهد کوکی‌های Home Screen app بعد از ۷ روز پاک شده‌اند [secondary: lists.webkit.org]. این تضاد با ادعای «معافیت» را فقط می‌توان با آزمایش روی دستگاه حل کرد.

**persist و eviction.** `persisted()` وضعیت را می‌دهد؛ `persist()` بر اساس heuristic است [source: webkit.org/blog/14403]. Eviction بر اساس LRU در سطح origin انجام می‌شود؛ origin دارای صفحهٔ فعال یا persistent ممکن است حذف نشود؛ و همهٔ داده‌های یک origin با هم حذف می‌شوند [source: webkit.org/blog/14403، MDN].

**حوادث گزارش‌شده.** WebKit bug 258859 گزارش پاک‌شدن localStorage و IndexedDB روی macOS 13.6.3 را دارد [secondary: نتیجه جستجو، تاریخ تأیید‌نشده]. یک باگ ۲۰۲۵ (اکتبر) نشان می‌دهد localStorage در iOS 26 برای سایتی که به IndexedDB fallback کرده بود، شکست می‌خورد؛ commit اصلاح به ۲۰۲۵-۱۰-۱۰ منتسب شده است [secondary: نتیجه جستجو، bugs.webkit.org].

| قابلیت | Chrome | Firefox | Safari desktop | Safari iOS | WKWebView | Android WebView |
|---|---|---|---|---|---|---|
| quota هر origin | ۶۰٪ دیسک | کمترین از ۱۰٪ دیسک یا ۱۰ GiB (best-effort) | ۶۰٪ (مرورگر) / ۱۵٪ (سایر) | همان | ۱۵٪ برای برنامهٔ غیرمرورگر (MDN: ~۱۵۰ GiB در مثال ۱TB) | تأیید‌نشده |
| سقف ۷ روزه | ندارد [inference] | ندارد [inference] | بله (ITP) [source] | بله (ITP) [source] | تأیید‌نشده | ندارد [inference] |
| persist() | خودکار بر اساس تعامل | پرسش از کاربر | heuristic | heuristic | تأیید‌نشده | تأیید‌نشده |

## ۲. Chrome، Firefox، Edge و Storage Buckets

**Chrome/Edge [source: MDN].** سقف هر origin ۶۰٪ دیسک؛ سقف کل ۸۰٪. eviction بر اساس LRU، origin persistent را رد می‌کند. تأیید persist خودکار است.

**Firefox [source: MDN].** best-effort: کمترین از ۱۰٪ دیسک یا ۱۰ GiB (group limit مشترک بین origin‌های یک site). persistent: تا ۵۰٪ دیسک با سقف ۸ TiB و خارج از group limit. کاربر پرسش می‌بیند. OPFS برای Firefox از نسخهٔ ۱۱۱ (۲۰۲۳-۰۳-۱۸) فعال است [source: sqlite.org news].

**حالت خصوصی Firefox.** MDN رقم مشخصی برای private browsing Firefox نمی‌دهد [source: MDN]؛ **تأیید‌نشده.**

**Storage Buckets.** Chromium از نسخهٔ ۱۲۲ bucket می‌سازد [secondary: caniuse snippet]؛ صفحهٔ رسمی Chrome در دسترس نبود (HTTP 403). caniuse برای `persist` در bucket، Firefox و Safari iOS را تا نسخه‌های ۱۵۸ و ۲۷.۲ پشتیبانی‌نشده گزارش می‌کند [secondary]. `navigator.storage.persist()` کلی را همه پشتیبانی می‌کنند [source: MDN]. **نتیجه:** Storage Buckets برای ما قابل اتکا نیست.

## ۳. OPFS

| قابلیت | Chrome | Firefox | Safari desktop | Safari iOS |
|---|---|---|---|---|
| createSyncAccessHandle | ۱۰۲ [secondary: caniuse] | ۱۱۱ [secondary] | ۱۵.۲ [secondary] | ۱۵.۲ [secondary] |
| sqlite OPFS VFS (`opfs`) | ✓ | ✓ (از ۱۱۱) | ۱۷+ عملی؛ زیر ۱۷ باگ WebKit [source: sqlite.org] | ۱۷+ [source: sqlite.org] |
| sqlite SAHPool (`opfs-sahpool`) | ✓ | ✓ | ۱۶.۴+ [source: sqlite.org] | ۱۶.۴+ [source: sqlite.org] |

- sync access handle فقط در Worker است و createSyncAccessHandle خودش async است [source: MDN، OPFS].
- sqlite.org (تاریخ ۲۰۲۶-۰۳) نشان می‌دهد `opfs` یک sync access handle را قفل می‌کند و خواندن هم قفل است. تست ۲۰۲۶-۰۳ ۸ تا ۱۰ worker هم‌زمان را با شرایطی پاس کرده است [source: sqlite.org/wasm/doc/trunk/persistence.md].
- عملکرد نسبت به IndexedDB: منبع معتبری پیدا نشد؛ **تأیید‌نشده**.
- باگ‌های شناخته‌شده: باگ WebKit زیر ۱۷ [source: sqlite.org]؛ حالت incognito ممکن است quota کمتر یا persistence نداشته باشد [source: sqlite.org].

## ۴. SQLite در مرورگر

| گزینه | وضعیت | نیاز COOP/COEP | چند تب | یادداشت |
|---|---|---|---|---|
| sqlite-wasm رسمی `opfs` | فعال؛ آخرین خبر ۲۰۲۶-۰۴-۰۹ (نسخهٔ 3.53.0) | بله | قفل سخت، نیاز به تعیین worker | [source: sqlite.org news] |
| sqlite-wasm `opfs-sahpool` | فعال | خیر | یک اتصال، بدون چند تب | [source: sqlite.org] |
| sqlite-wasm `opfs-wl` | در 3.53.0 (۲۰۲۶-۰۴-۰۹) | تأیید‌نشده | Web Locks با FIFO | نیاز به Atomics.waitAsync [source: sqlite.org] |
| sqlite-wasm kvvfs | main thread، ~۵ MB | خیر | — | برای سقف کم مناسب نیست [source: sqlite.org] |
| wa-sqlite | مخزن فعال (۱٬۰۴۰ commit)؛ تاریخ آخرین commit تأیید‌نشده | تأیید‌نشده | VFS های OPFSCoopSync، AccessHandlePool، IDBBatchAtomic و ... | README به Safari اشاره‌ای ندارد [source: github.com/rhashimoto/wa-sqlite] |
| sql.js | تأیید‌نشده | — | — | در این جستجو بررسی نشد |
| absurd-sql | تأیید‌نشده | — | — | در این جستجو بررسی نشد |

- FTS5 در build رسمی: **تأیید‌نشده**. صفحهٔ building از FTS5 نامی نمی‌برد [source: sqlite.org/wasm/doc/trunk/building.md]. [inference] چون sqlite-wasm از amalgamation رسمی ساخته می‌شود، احتمال زیاد FTS5 وجود دارد؛ باید با `PRAGMA compile_options` تست شود.
- اندازه باندل و عملکرد: **تأیید‌نشده**.
- شروع کار با sqlite-wasm رسمی را می‌توان با `opfs-sahpool` در یک Worker شروع کرد، اما هم‌زمانی چند تب در آن کار نمی‌کند.

## ۵. IndexedDB

- باگ ۱۹۷۰۵۰ (۲۰۱۹): بعد از background، iOS Safari ممکن است connection را ببندد و تراکنش بعدی با `InvalidStateError` شکست بخورد؛ راه‌حل باز کردن connection جدید است [secondary: bugs.webkit.org].
- باگ ۲۲۲۷۴۶ (۲۰۲۱): تراکنش در iOS 13.4 با await یک microtask بسته می‌شود [secondary].
- باگ ۲۱۶۷۶۹ (۲۰۲۰): auto-commit و inactive شدن تراکنش در Safari 12–14.0 [secondary].
- باگ ۳۱۵۸۰۴ (تاریخ تأیید‌نشده): `put` بعد از reopen کار نمی‌کند [secondary].
- `onversionchange`: در منابع بازبینی‌شده منبع معتبری برای رفتار Safari پیدا نشد؛ **تأیید‌نشده**.
- `durability: 'strict'`: **تأیید‌نشده**.
- wrappers: Dexie نسخهٔ 4.4.7 را در ۱۹ اکتبر (سال نامشخص در صفحه) منتشر کرده؛ یادداشت انتشار به Safari-like environment بدون indexedDB اشاره دارد [source: github.com/dfahlander/Dexie.js/releases]. **تأیید سال.**
- [inference] برای قابلیت‌های حجیم (چند صد مگابایت) محدودیت IndexedDB در Safari iOS بر اساس quota است، نه تعداد کلید.

## ۶. Web Locks، BroadcastChannel، Service Worker و Background Sync

| قابلیت | Chrome | Firefox | Safari desktop | Safari iOS | WKWebView | Android WebView |
|---|---|---|---|---|---|---|
| Web Locks | ۶۹ | ۹۶ | ۱۵.۴ | ۱۵.۴ | تأیید‌نشده | تأیید‌نشده |
| BroadcastChannel | ۵۴ | ۳۸ | ۱۵.۴ | ۱۵.۴ | تأیید‌نشده | تأیید‌نشده |
| Background Sync | ۴۹ | ✗ | ✗ | ✗ | ✗ [secondary] | تأیید‌نشده |
| Periodic Background Sync | جدا ردیابی نشده | ✗ | ✗ | ✗ | ✗ | تأیید‌نشده |

[secondary: caniuse] همهٔ منابع caniuse در این جستجو از نظر نسخهٔ آخر با هم کامل سازگار نبودند؛ جدول بالا بر اساس اولین نسخهٔ پشتیبانی است.

- leader election: Web Locks در همهٔ موتورهای مدرن موجود است [secondary]؛ BroadcastChannel برای پیام است، نه قفل [inference].
- عمر Service Worker در iOS: گزارش‌های Apple Developer Forums (۱۷.۴ تا ۱۸) نشان می‌دهد SW بعد از چند ثانیه تا چند ساعت کشته شده و اتصال ممکن است غیرقابل بازیابی باشد [secondary: anecdotal، forums]. Apple سندی رسمی برای این ندارد [تأیید‌نشده].
- گزینهٔ کاری: sync را در صفحهٔ اصلی و روی رویداد `online` اجرا کنیم.

## ۷. WebView (WKWebView و Android WebView)

- Tauri و Capacitor روی iOS/macOS از WKWebView استفاده می‌کنند. WebKit می‌گوید برنامهٔ غیرمرورگر سقف کمتری دارد؛ اما منبع معتبری پیدا نشد که قوانین WKWebView را با Safari یکی بداند [secondary: نتیجه جستجو]. **تأیید‌نشده.**
- گزارش‌های Apple Developer Forums از دست رفتن localStorage در WKWebView روی iPhone خبر می‌دهند [secondary].
- یک wrapper developer گفته IndexedDB در بعضی دستگاه‌ها در WKWebView کار نمی‌کند [secondary].
- Android WebView: صفحهٔ رسمی Android (`developer.android.com`) با HTTP 403 برگشت؛ **تأیید‌نشده**.
- قوانین WKWebView برای Tauri: جستجوی منبع Tauri-specific پیدا نشد؛ **تأیید‌نشده**.

## ندانسته‌ها

- وضعیت ۲۰۲۶ سقف ۷ روزه: آیا هنوز برای همهٔ محتوای ITP اجرا می‌شود؟ منبع ۲۰۲۳ WebKit آن را ذکر نمی‌کند. تأیید‌نشده.
- معافیت دقیق Home Screen در سال ۲۰۲۶ (از جمله کوکی‌های JS و cloaked third-party): تأیید‌نشده.
- اجرای جدول‌های MDN (Web Locks، OPFS) و caniuse برای Safari 26 و Firefox 163: صفحه‌های MDN جدول مرورگر را برنگرداندند؛ نسخه‌های caniuse ممکن است قدیمی باشند.
- Chrome Storage Buckets (صفحهٔ اصلی 403) و Safari storage policy 2025-2026: بررسی نشد.
- عملکرد OPFS نسبت به IndexedDB و اندازهٔ باندل sqlite-wasm/wa-sqlite: منبع پیدا نشد.
- FTS5 در build رسمی و wa-sqlite: تأیید‌نشده.
- sql.js و absurd-sql: وضعیت نگهداری بررسی نشد.
- حالت خصوصی Firefox و quota آن: تأیید‌نشده.
- WKWebView و Android WebView: قوانین storage تأیید‌نشده؛ Tauri/Capacitor خاص بررسی نشد.
- باگ‌های IndexedDB در Safari 17/18/26 (با تاریخ و وضعیت): بیشترشان قدیمی‌اند و تاریخ‌شان مشخص نیست؛ تأیید‌نشده.
- هیچ ادعای امنیتی یا آزمایش عملی روی دستگاه انجام نشده است.
