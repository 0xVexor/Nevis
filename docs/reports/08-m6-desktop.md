# گزارش 08: M6 — دسکتاپ Tauri 2 + SQLite + Net در Rust

- تاریخ: 2026-11-21 · تگ: `m6` · commit: `git log m6`
- هدف: همان اپ M5 در یک پنجرهٔ دسکتاپ با دادهٔ SQLite بومی، شبکه و توکن دستگاه در Rust.
- وضعیت: **بخش خودکار روی macOS کامل و سبز.** Windows اصلاً ساخته و اندازه‌گیری نشد (فقط macOS در دسترس بود). رفتار keychain واقعی، رابط عادی اپ (فرم سرور، ورود، بستن پنجره) و تایپ فارسی واقعی با مالک است (`docs/checklists/M6.md`).

## چه ساخته شد
**Rust (`apps/desktop/src-tauri`)**
- `store.rs`: SQLite (WAL، `synchronous=NORMAL`) با جدول‌های ADR-0001. `commit(ops)` یک تراکنش؛ هر نوشتن شرطی نتیجه‌ای را که JS فرض کرده (`wrote`، `inserted`، `k`، `ok`) در batch می‌آورد و Rust آن را دوباره حساب می‌کند: اختلاف = rollback کل batch (جلوی «drift» بین overlay و پایگاه). خواندن‌ها typed است (`store_read`)، SQL دلخواه نیست.
- `net.rs` + `lib.rs`: `net_request` فقط مسیر `/v1/...` (بدون `..`، `//`، `@`)، فقط آدرس سرور تنظیم‌شده (`server_set`، فقط origin)، `Nevis-Proto: 1` را خودش می‌گذارد، `Authorization` JS را نمی‌پذیرد (JS هدر نمی‌فرستد)، قابل لغو (`net_cancel` برای long-poll). `auth_signin`/`auth_signup` به‌عنوان **دستگاه**: توکن به keychain می‌رود و از پاسخ حذف می‌شود؛ `guard` هر پاسخی را که توکن در آن باشد مسدود می‌کند.
- `secrets.rs`: keychain (`keyring`) پشت یک trait؛ پشتیبان فایل فقط با `NEVIS_TEST_TOKEN_FILE` برای آزمون خودکار (keychain روی build امضانشده بعد از هر build دوباره رمز می‌پرسد و آزمون را معلق می‌کند).
- بستن پنجره: Rust بستن را نگه می‌دارد، رویداد `nevis://flush` می‌فرستد، منتظر `flush_done` می‌ماند (حداکثر ۵s)، سپس می‌بندد. (فقط اگر صفحه ثبت کرده باشد؛ در حالت‌های آزمون بدون انتظار.)
- حالت‌های خودکار: `--self-test`، `--bench`، `--typing` (+`NEVIS_VERIFY=1`)، `--sync`؛ هر کدام صفحهٔ خودش را از همان bundle وب بار می‌کند و با `app_exit` با کد خروج تمام می‌شود.
- پنجره با `use_https_scheme(true)` ساخته می‌شود (ثابت؛ ADR-0013). CSP محدود: `default-src 'self'`.

**TypeScript**
- `packages/store-tauri` (`TauriStore`): `run(fn)` تعاملی ← یک `store_commit`. خواندن‌ها از وضعیت committed + overlay نوشته‌های همان تراکنش؛ صف یک‌به‌یک؛ پرتاب خطا = هیچ چیز ارسال نمی‌شود. بایت‌ها base64 داخل JSON.
- `apps/web/src/desktop.ts` (تنها جای آگاه از Tauri): `openDesktopStore`، `desktopFetch` (fetch از راه `net_request`)، `onWindowFlush`. `runtime.ts`/`auth.ts`/`main.tsx` با `isDesktop` انتخاب می‌کنند؛ یک bundle برای وب و دسکتاپ؛ فرم «آدرس سرور» فقط در دسکتاپ.
- `harness.ts`: runner conformance مشترک (IDB و SQLite).

## نتایج (اجرا شده روی macOS، 2026-11-21)
| معیار ROADMAP | نتیجه |
|---|---|
| conformance سبز | `node apps/desktop/scripts/selftest.mjs`: **۱۰/۱۰** conformance روی SQLite داخل خود اپ + ۵ بررسی دیگر = **۱۵/۱۵** |
| p95 `store_commit` < ۵۰ms | تایپ ۱۰ کلید/ثانیه، ۶۰ ثانیه، ادیتور واقعی + DocHandle (۳۰۰ms throttle): `store_commit` **p50 ۳ms، p95 ۵ms، max ۱۰ms** (n=۱۷۸)؛ کل `run` (خواندن‌ها + commit) p50 ۱۳ms، p95 ۱۷ms، max ۴۷ms. batch ۲۰ نوشتن: commit p95 ۳ms، کل p95 ۲۸ms. (`performance.now()` در WebKit با دقت ~۱ms؛ **فقط macOS**.) go/no-go: عبور با فاصلهٔ زیاد |
| kill حین تایپ → ≤ ۳۰۰ms | `node apps/desktop/scripts/kill.mjs 10`: ۱۰ بار SIGKILL در لحظهٔ تصادفی؛ بیشترین از دست رفتن **۲۰۰ms** تایپ (۴ نویسه)؛ ۱۰/۱۰ در پنجره |
| دسکتاپ و وب روی یک حساب همگرا | `node apps/desktop/scripts/converge.mjs`: دسکتاپ صفحه و متن می‌نویسد؛ Chromium وارد می‌شود، می‌بیند، متن و صفحه اضافه می‌کند؛ دسکتاپ **دوباره راه‌اندازی بدون ورود** (توکن از store) هر دو طرف را دارد |
| توکن در هیچ پاسخ IPC به JS نیست | (۱) خود `selftest`: پاسخ ثبت‌نام کلید `token` ندارد، `hasToken` درست، `me()` با توکن نگه‌داشته‌شده کار می‌کند، و شمارندهٔ پاسخ‌های مسدودشده ۰ است؛ (۲) `cargo test`: `strip_token` و `guard`. **محدودیت:** روی تک‌تک پاسخ‌های همهٔ فرمان‌ها یک ضبط‌کنندهٔ کامل نیست؛ فقط فرمان‌های شبکه/ورود از `guard` رد می‌شوند (فرمان‌های store اصلاً به توکن دسترسی ندارند) |
| `cargo test` | ۹ آزمون (اتمی بودن batch و rollback با drift، LWW شرطی، شمارندهٔ `k`، ترتیب outbox، ماندگاری بعد از بستن فایل، مسیر/آدرس مجاز، توکن) |
| web | typecheck و آزمون همهٔ بسته‌ها سبز؛ Playwright سه موتور ۳۴ سبز و ۲ skip عمدی (بدون پسرفت از تغییر `runtime/auth/main`) |

## کار نمی‌کند / آزموده نشده (صادقانه)
- **Windows:** ساخته و اجرا نشد؛ اعداد IPC و مشکلات build ویندوز ثبت نشد.
- **keychain واقعی:** آزمون‌های خودکار با پشتیبان فایل اجرا شدند. رفتار `keyring` روی macOS (پرسش رمز بعد از هر build، «Always Allow») و ورود دوباره بدون رمز با keychain واقعی با مالک است (چک‌لیست ۲، ۳، ۹).
- **رابط عادی اپ** (فرم آدرس سرور، فرم ورود، فهرست فضاها در WebView) و **بستن پنجره با flush** در اپ واقعی اجرا نشد: محیط من امکان screenshot/کلیک روی پنجره نداشت. کد آن‌ها تایپ‌چک شده و مسیر ثبت‌نام/سینک/صفحه با `--sync` اجرا می‌شود، ولی خود UI و رویداد `CloseRequested` فقط با چک‌لیست (۱، ۸) تأیید می‌شوند.
- **سینک وقتی پنجره پنهان است** (ADR-0007 بند ۷) اندازه‌گیری نشد.
- **سطل زباله، زیرصفحه و جابه‌جایی** در دسکتاپ فقط از راه همان کد مشترک با وب آزموده می‌شوند (آزمون Playwright وب)؛ آزمون خودکار روی خود دسکتاپ ندارند.
- `TauriStore` فقط در برابر یک نویسندهٔ واحد درست است؛ اگر دو پنجره/فرایند به یک فایل بنویسند (اپ دوم باز شود) drift رخ می‌دهد و Rust batch را رد می‌کند (خطا، نه خرابی داده). قفل تک‌نمونه (single instance) ساخته نشد.
- بایت‌ها base64 داخل JSON هستند؛ برای ۱۰ کلید/ثانیه کافی بود (اعداد بالا). اگر بدنه‌های بزرگ (ده‌ها MB) در M9 بیایند، IPC باینری لازم می‌شود.
- آیکن اپ یک نمونهٔ موقت است؛ bundle/امضا/updater ساخته نشد (طبق ROADMAP).

## تصمیم‌ها
مطابق ADR-0001 §7 (یک فرمان per تراکنش، typed، SQLite WAL)، ADR-0007 §7 (بستن پنجره)، ADR-0013 §2 (`use_https_scheme` ثابت). تصمیم‌های پیاده‌سازی بدون ADR جدید: (الف) overlay سمت JS با تأیید نتیجهٔ شرطی در Rust؛ (ب) پشتیبان فایل توکن فقط با متغیر محیطی آزمون؛ (ج) `guard` که پاسخ حاوی توکن را مسدود می‌کند.

## فایل‌های کلیدی
`apps/desktop/src-tauri/src/{lib,store,net,secrets}.rs` · `apps/desktop/scripts/{lib,selftest,bench,kill,converge}.mjs` · `packages/store-tauri/src/tauriStore.ts` · `apps/web/src/{desktop,desktop-selftest,desktop-bench,desktop-typing,desktop-sync,harness}.ts`.

## مشکلات و ریسک‌های باز
- keychain بدون امضا؛ Windows؛ تک‌نمونه‌بودن؛ سینک پنهان؛ نتیجهٔ ۷ روزهٔ M3 و چک‌لیست M5 هنوز با مالک است.

## قدم بعدی دقیق
۱) مالک چک‌لیست `docs/checklists/M6.md` (و M5). ۲) بعد از تأیید: **M7 — دادهٔ ساختاریافته** (`docs/ROADMAP.md` بخش M7؛ ADR-0004): موجودیت‌های `database`، `property`، `view`، `row`، `tag`، `settings`؛ harness همگرایی با این عملیات؛ UI حداقلی جدول. فقط TypeScript و `packages/core`.

## ادامه از صفر
```bash
cd /Users/wrangler/Developer/Projects/nevis-next
corepack pnpm install
corepack pnpm -r --if-present test && (cd server && go test -race ./...)
(cd apps/desktop/src-tauri && cargo test)
node apps/desktop/scripts/selftest.mjs        # build + conformance در اپ (NO_BUILD=1 برای رد کردن build)
node apps/desktop/scripts/bench.mjs 60        # IPC
node apps/desktop/scripts/kill.mjs 10         # kill حین تایپ
node apps/desktop/scripts/converge.mjs        # دسکتاپ + وب روی یک حساب
```
(پکیج `@nevis/desktop` همین‌ها را با `test:conformance`، `bench:ipc`، `test:kill` و `tauri` هم در `package.json` دارد؛ `test:converge` را اضافه کنید یا مستقیم `node` بزنید.)
