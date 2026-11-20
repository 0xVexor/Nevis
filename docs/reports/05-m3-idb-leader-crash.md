# گزارش 05: M3 — ذخیرهٔ IndexedDB + leader چندتب + crash مرورگر

- تاریخ: 2026-11-21 · تگ: `m3` · هدف: ثابت کنیم هسته روی IndexedDB واقعی در Chromium، WebKit و Firefox درست و crash-safe است و چند تب با یک leader سینک می‌کنند (ADR-0001 وب، ADR-0007 بند ۵).
- وضعیت: **go برای بخش خودکار.** معیارهای ۱ تا ۵ سبز. **چک‌لیست iPhone/Safari واقعی و آزمون ۷ روزه با مالک است** (go/no-go نهایی ADR-0001 به نتیجهٔ iPhone وابسته است).

## چه ساخته شد
- `packages/store-idb` (`@nevis/store-idb`): `IdbStore` — هر `run` یک تراکنش readwrite روی همهٔ storeها با `durability: 'strict'`؛ داخل تراکنش فقط درخواست‌های IndexedDB await می‌شوند (تله‌ی auto-commit در Safari)؛ اتصال بسته‌شده دوباره باز می‌شود؛ `onversionchange` اتصال را می‌بندد و پیام می‌دهد؛ LWW شرطی با `get`+`put` در همان تراکنش.
- `packages/core`: `TabCoordinator` (قفل Web Locks `nevis-sync-<ws>` برای leader، پیام `changed` روی BroadcastChannel، backoff نمایی ≤ ۳۰s، `kick`) فقط از پورت‌ها (`LockPort`، `ChannelPort`)؛ `httpNet` (پورت `Net` روی fetch؛ همان پیاده‌سازی در مرورگر و در harness M2)؛ مجموعهٔ conformance حالا **مستقل از vitest** (`storeConformance(harness, …)`) تا در خود مرورگر اجرا شود؛ `tsconfig` هسته بدون `DOM` (قاعدهٔ ADR-0007 اجرا شد).
- `apps/web` («آزمایشگاه M3»): فهرست یادداشت‌ها، «۱۰۰ یادداشت»، «+۱ همه»، «۵ دور نوشتن پشت سر هم»، «پرکردن ۱۰۰MB» (دادهٔ غیرسینک در پایگاه جدا)، «قطع شبکه (شبیه‌سازی)»، نوار وضعیت (leader، outbox، inbox، cursor، `persisted()`، `estimate()`). از راه پروکسی Vite به سرور Go (same-origin).
- `docs/dev-https.md`، `docs/checklists/M3.md`.

## نتایج
| معیار | نتیجه |
|---|---|
| ۱ conformance در Node (fake-indexeddb) و در سه مرورگر | **۹/۹** در هر چهار محیط: Node، Chromium (Chrome نصب‌شده)، WebKit (Playwright)، Firefox |
| ۲ crash: بستن صفحه حین نوشتن | **Chromium ۵۰ بار، WebKit ۲۵، Firefox ۲۵** (بستن ۱۰–۲۵۰ms بعد از شروع burst از ۳۰۰ نوشتن)؛ بعد از بازکردن و سینک، حالت دستگاه با حالتی که یک پروفایل مرورگر **تازه** از لاگ سرور می‌سازد **یکسان است**؛ هیچ نوشتن نصفه‌ای نبود |
| ۳ دو تب | در هر سه موتور دقیقاً یک leader؛ تحویل leader بعد از بستن: Chromium ۵–۲۱۵ms، WebKit ۵۷ms، Firefox ۲۲ms (حد ۲s)؛ رسیدن تغییر به تب دیگر **بدون شبکه** (BroadcastChannel): Chromium ۱۲ms، WebKit ۹ms (حد ۱s) |
| ۴ دو موتور روی یک workspace | Chromium + WebKit: هر دو آفلاین ویرایش (عنوان، شمارنده، یادداشت تازه) → آنلاین → **همگرا**، هر چهار ویرایش حفظ شد |
| ۵ `persist()` | در اولین بارگذاری صدا زده می‌شود و جواب نمایش داده می‌شود. مقدار در headless: Chromium `false`، WebKit `false`، Firefox `null` (جواب نداد) |
آزمون‌ها: protocol ۶۴، core ۲۳، store-idb ۹، converge ۲ و e2e مرورگر (۳ موتور × ۵ آزمون + یک آزمون دو-موتوری).

## یافته‌ها (برای معمار)
- **`navigator.storage.persist()` در Firefox معلق می‌ماند** (پرسش اجازه از کاربر). اگر بوت به آن گره بخورد، برنامه هرگز باز نمی‌شود. حالا در پس‌زمینه پرسیده می‌شود. ADR-0001 بند ۶ همین را بگوید: «persist را await نکن».
- آزمون هم‌زمانی conformance در نسخهٔ M2 با `setTimeout` داخل تراکنش نوشته شده بود که در IndexedDB واقعی تراکنش را زود commit می‌کند؛ اصلاح شد: داخل `run` فقط `await tx.*`. این قاعده برای هر آداپتور آینده هم هست.
- `webkit` در Playwright ≠ Safari ≠ iOS. نتیجهٔ دستگاه واقعی فقط با چک‌لیست.
- ترتیب `outbox` در IndexedDB با `autoIncrement` = ترتیب درج (همان قاعدهٔ M2).

## چه چیزی آزموده نشده (صادقانه)
- iPhone و Safari واقعی (kill حین نوشتن، background/foreground، `persisted()`، Home Screen، آزمون ۷ روزه): **فقط با چک‌لیست مالک** (`docs/checklists/M3.md`، `docs/dev-https.md`).
- Android Chrome.
- eviction تحت فشار حافظه (دکمهٔ ۱۰۰MB وجود دارد؛ رفتار آن را فقط دستگاه واقعی نشان می‌دهد).
- دو تب با دو تغییر هم‌زمان در یک سند Yjs (UI ادیتور در M5).
- crash با قطع واقعی برق یا kill -9 مرورگر (فقط `page.close()`؛ تراکنش‌های ناتمام IndexedDB توسط خود مرورگر abort می‌شوند).
- راه الف/ب HTTPS هنوز اجرا نشده؛ فقط مستند است (مالک انتخاب کند).

## فایل‌های کلیدی
`packages/store-idb/src/idbStore.ts`، `packages/core/src/{coordinator,http,conformance,testing}.ts`، `apps/web/src/{lab,ports,main,conformance}.ts(x)`، `apps/web/tests/*.spec.ts` و `two-engines.mjs`، `docs/dev-https.md`، `docs/checklists/M3.md`.

## دستورها (از صفر)
```
pnpm install
pnpm --filter @nevis/store-idb test                    # conformance روی fake-indexeddb
npx playwright install webkit firefox                  # یک بار (Chrome باید نصب باشد)
pnpm --filter web test:e2e                             # سه موتور؛ سرور Go را خودش می‌سازد و بالا می‌آورد
pnpm dev:server                                        # ترمینال ۱
pnpm --filter web dev                                  # ترمینال ۲: http://localhost:5174  (دو تب باز کنید)
```

## قدم بعدی دقیق
۱) مالک `docs/checklists/M3.md` را روی Safari macOS و iPhone اجرا و آزمون ۷ روزه را شروع کند؛ ۲) **M4**: سرور واقعی (حساب، نشست، workspace، دستگاه، long-poll، `WEB_DIR` با CSP، `Nevis-Proto`/`426`، `minSv`) روی همین سرور Go؛ ۳) معمار ADR-0001 بند ۶ را با یافتهٔ `persist()` به‌روز کند.
