# گزارش 03: M1 — spike ادیتور (y-tiptap + فارسی + dir + جدول)

- تاریخ: 2026-11-21 · تگ: `m1` · هدف: go/no-go برای ADR-0003 (بدنهٔ سند با Yjs)
- وضعیت: **مشروط-go (منتظر چک‌لیست دستگاه مالک)**. همه‌ی معیارهای خودکار پاس شدند؛ دو یافتهٔ مهم برای معمار (پایین). نتیجهٔ Safari macOS و iPhone هنوز نیامده: `docs/checklists/M1.md`.

## چه ساخته شد
- ریشهٔ monorepo (pnpm 12.21.0، Node 24، `.npmrc` با `save-exact=true`).
- `packages/schema` (`@nevis/schema`): schema TipTap (doc، paragraph، heading ۱–۳، فهرست‌ها، taskList/taskItem با `checked`/`due`، blockquote، codeBlock، جدول، hardBreak؛ markهای bold/italic/code/link)، attrها بدون null، `dir` و `blockId`، افزونهٔ هویت بلوک، `uuidv7`، `project(doc)`، `normalize`.
- `spikes/m1-editor`: صفحهٔ دو ادیتور (هر کدام Y.Doc خودش) با relay حافظه‌ای (تأخیر، آفلاین، تحویل تکراری)، ربات تایپ، دکمه‌های dir، جدول ۳×۳، undo/redo، پروژکشن و نشانگر همگرایی، اندازهٔ state؛ صف composition (قابل خاموش/روشن).
- آزمون‌ها: `@nevis/schema` (Vitest، Node بدون DOM)، `m1-editor` (Vitest برای relay)، fuzz و IME (Playwright، Chrome واقعی).

## نسخه‌های پین‌شده (`npm view` در 2026-11-21)
`yjs` 13.6.33 · `y-protocols` 1.0.7 · `@tiptap/y-tiptap` **3.3.1** (تناقض دو گزارش تحقیق حل شد: 3.3.1) · `@tiptap/core`/`pm`/`starter-kit`/`extension-*`/`react`/`extension-collaboration` 3.35.0 · `react` 19.3.1 · `vite` 8.3.8 · `vitest` 5.1.1 · `fast-check` 4.10.3 (نصب‌شده، هنوز استفاده نشده) · `@playwright/test` 1.65.1 · `typescript` 5.9.3 (7.0.2 عمداً نه).

## نتایج (همه با دستورهای زیر قابل بازتولید)
| معیار | نتیجه |
|---|---|
| ۱ پین نسخه | انجام شد |
| ۲ schema در Node بدون DOM | ✓ (۲۵ آزمون) |
| ۳ round-trip ۱۰ fixture | ✓ با پیش‌فرض‌های پرشده؛ replica تازه با `encodeStateAsUpdate` همان projection را می‌دهد |
| ۴ هیچ attribute با null | ✓ روی fixtureها و پایان همهٔ fuzzها (0 مورد) |
| ۵ `blockId` یکتا/غیرخالی بعد از split/paste/split هم‌زمان | ✓ در ۴۰۰ اجرای fuzz همیشه یکتا و معتبر (`idsNotOk: []`) |
| ۶ fuzz ۲۰۰ seed × ۵۰۰ گام | بدون undo: **۲۰۰/۲۰۰** Y.Doc برابر، ۰ ناهماهنگی view، ۰ RangeError، ۰ خطا. با undo: **۲۰۰/۲۰۰** برابر، ۰ ناهماهنگی view، ۰ RangeError، **۱ خطا** (`Cannot read properties of undefined (reading '_item')`، از undo) |
| ۷ اندازه (۱۰۰ پاراگراف، ۳۰ چرخهٔ undo/redo) | ۱۸٬۷۸۴ → ۲۸٬۴۸۳ بایت (حد ۲MB) ✓. بیشینهٔ اندازه در fuzz ۵۰۰ گامه: ۱۱۵٬۴۱۶ بایت |
| ۸ IME با CDP | ✓ (جدول پایین) |
| round-trip/آفلاین/جدول/dir در صفحهٔ واقعی | ✓ (آزمون Playwright) |

### یافتهٔ ۱ — ترمیم `blockId` روی تراکنش با مبدأ Yjs به Y.Doc برنمی‌گشت (و رفع شد)
`appendTransaction` برای ترمیم id روی تراکنشی که از Yjs آمده کار می‌کند ولی `@tiptap/y-tiptap` تراکنش با `isChangeOrigin` را به Y.Doc برنمی‌نویسد؛ نتیجه: view id تازه داشت و Y.Doc id قدیمی/خالی (در حدود نیمی از seedها). رفع: ترمیم روی تراکنش با مبدأ Yjs یک تراکنش محلی جدا یک microtask بعد است (`packages/schema/src/blockIdentity.ts`). بعد از رفع، ۰ ناهماهنگی در ۴۰۰ اجرا. **ADR-0003 بند ۵ این را دقیق‌تر بگوید.**

### یافتهٔ ۲ — صف composition لازم است و سقف ۲ ثانیه کافی نیست
آزمون CDP (`Input.imeSetComposition`) با ربات که در **همان پاراگراف** می‌نویسد، با کلمهٔ یکتا «ژاژ» (هیچ کلمهٔ ربات «ژ» ندارد):
| حالت | کلمه ثبت‌شده | «ژ» (انتظار ۲) |
|---|---|---|
| بدون صف، composition ۲٫۷s | ×۲ (تکراری) | ۶ ✗ |
| صف روشن، سقف ۲s، composition ۱٫۵s | ×۱ | ۲ ✓ |
| صف روشن، سقف ۲s، composition ۲٫۷s | ×۲ | ۴ ✗ |
| صف روشن، سقف ۱۰s، composition ۲٫۷s | ×۱ | ۲ ✓ |
یعنی بدون صف متن خراب می‌شود و سقف ۲ثانیه‌ای ADR-0003 بند ۱۳ برای compositionهای طولانی‌تر خراب می‌کند. **پیشنهاد (تصمیم با معمار):** نگه‌داشتن تا `compositionend` با سقف سخت ~۱۰s. spike پیش‌فرض ۱۰s گذاشته. **هنوز نمی‌دانیم iOS Safari با IME واقعی چطور رفتار می‌کند.**

## چه چیزی آزموده نشده (صادقانه)
- Safari macOS و iPhone (IME واقعی، پیش‌بینی روشن): فقط با چک‌لیست مالک.
- Android Chrome.
- جدول با ستون‌های تغییر اندازه (`colwidth` عمداً حذف شد چون null بود؛ در M8a برگردانده شود به شکل بدون null).
- `taskItem`/`codeBlock` در fuzz فقط از طریق fixture (نه عملیات تصادفی اختصاصی).
- fast-check هنوز استفاده نشد (fuzz خانگی با PRNG).
- یک خطای `_item` در undo: ناشناخته که از y-tiptap است یا از ترکیب ما؛ بازتولید با seed.

## تصمیم و پیشنهاد go/no-go
معیارهای عددی: (الف) ۱۰۰٪ ✓؛ (ب) بدون undo ۰٪ و با undo ۰٪ (حد ۱٪ و ۵٪) ✓؛ اندازه ✓. **go مشروط به چک‌لیست iPhone/Safari مالک و پذیرش بند صف composition با سقف بلندتر.** اگر iPhone رد شد: طبق ROADMAP توقف و معمار تصمیم بگیرد.

## فایل‌های کلیدی
`packages/schema/src/{extensions,blockIdentity,ids,index}.ts`، `packages/schema/test/*`، `spikes/m1-editor/src/{App,fuzz,relay,editor}.ts(x)`، `spikes/m1-editor/tests/{fuzz.spec,ime.spec,relay.test}.ts`، `spikes/m1-editor/results/*.json`، `docs/checklists/M1.md`.

## دستورها (از صفر)
```
corepack enable            # یا: npm i -g pnpm@12.21.0
pnpm install
pnpm --filter @nevis/schema test
pnpm --filter m1-editor test
pnpm --filter m1-editor test:fuzz     # ۲۰۰×۵۰۰، حدود ۳۰ ثانیه؛ FUZZ_SEEDS/FUZZ_STEPS قابل تنظیم
pnpm --filter m1-editor test:e2e      # Chrome نصب‌شده لازم است
pnpm --filter m1-editor dev -- --host # http://localhost:5173
```

## قدم بعدی دقیق
۱) مالک `docs/checklists/M1.md` را اجرا و نتیجه را همین‌جا بنویسد؛ ۲) معمار بند ۵ و ۱۳ ADR-0003 را طبق یافته‌ها اصلاح کند؛ ۳) M2 (هستهٔ لاگ + سرور Go + harness) که مستقل است.
