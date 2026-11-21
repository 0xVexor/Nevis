# گزارش 07: M5 — برش عمودی وب (صفحه + بدنهٔ Yjs + سینک واقعی)

- تاریخ: 2026-11-21 · تگ: `m5` · commitها: `8553bc0` (هستهٔ صفحه/درخت/DocHandle)، `49f51e1` (`@nevis/editor`، بنچ ۱۰k)، و commit نهایی M5 (رابط وب، آزمون‌ها، docs؛ `git log m5`).
- هدف: یادداشت فارسی در وب، آفلاین‌فرست، همگرا بین دو مرورگر از راه سرور خودمان.
- وضعیت: **بخش خودکار کامل و سبز.** Safari/iPhone واقعی، IME واقعی و نتیجهٔ آزمون ۷ روزهٔ M3 با مالک است (`docs/checklists/M5.md`).

## چه ساخته شد
- `packages/core`: `pages.ts` (موجودیت page: `title`، `parent`، `sortKey`، `trashed`، `kind`، `createdAt`)، `tree.ts` (projection درخت با قاعدهٔ چرخه)، `docHandle.ts` (Y.Doc باز؛ نوشتن محلی throttle ۳۰۰ms در یک تراکنش با ردیف outbox؛ منشأ `REMOTE` برای update ذخیره‌گاه؛ flush عمومی؛ دروازهٔ `sv`)، compaction محلی، خواندن گروهی `allFields` در Store (۱۰k صفحه).
- `packages/editor` (`@nevis/editor`): کارخانهٔ ادیتور مشترک بین spike و اپ.
- `apps/web`: `runtime.ts` (`SyncRuntime`: store + engine + long-poll + coordinator؛ مشترک بین Lab و Workspace)، `workspace.ts`، `WorkspaceView.tsx`، `PageTreeView.tsx`، `EditorPane.tsx`: درخت صفحه، ساخت/تغییر نام/زیرصفحه/جابه‌جایی/سطل/بازگردانی، ادیتور، نشانگر وضعیت (آنلاین، ارسال‌نشده، خطا)، پیام «به‌روزرسانی لازم» برای `max_sv > SV`، flush در `pagehide`/`visibilitychange`.
- `tools/bench` (`corepack pnpm bench:startup`)، `tools/converge` حالا ویرایش بدنه را از راه `DocHandle` می‌زند (+ گزینهٔ `--from N`).

## نتایج (اجرا شده، 2026-11-21)
| معیار ROADMAP | نتیجه |
|---|---|
| ۱ دو موتور آفلاین → همگرایی ≤ ۵s | `apps/web/tests/two-engines-pages.mjs`: Chromium+WebKit یک حساب؛ هر دو آفلاین، ویرایش **همان صفحه** و ساخت صفحهٔ جدا؛ در حالت آفلاین آزمون ثابت می‌کند دو طرف واقعاً فرق دارند (۲ صفحه هر طرف، ویرایش طرف مقابل نیامده، outbox > ۰)؛ آنلاین → ۳ صفحه و متن یکسان با هر دو ویرایش، **~۱۰۰ms** پس از اتصال |
| ۲ crash ≥ ۳۰۰ms | `pages.spec.ts` (۴۰۰ms بعد از آخرین کلید، سه موتور) سبز؛ `crash.spec.ts` (۵۰ بستن تصادفی) سبز |
| ۳ ۱۰k صفحه | لیست قابل‌استفاده: Chromium **۲۴۱ms**، WebKit **۱۸۵ms**، Firefox **۲۵۵ms** (حد ۲s)؛ باز کردن صفحه median ۱۷/۱۷/۱۶ms، p95 ۱۷/۲۲/۱۷ms (حد ۲۰۰ms) |
| ۴ `max_sv > SV` | `pages.spec.ts` (سه موتور): پیام `needs-update` و ادیتور باز نمی‌شود |
| ۵ compaction | `docHandle.test.ts`: بعد از ۵۰۰ ویرایش tail کوتاه، متن بدون تغییر، outbox دست‌نخورده |
| ۶ تأخیر ویرایش→دستگاه دوم | همان اسکریپت، ۶۰ نمونه، Chromium→WebKit روی localhost: median ۳۳۸ms، p95 ۳۴۵ms، max ۳۴۷ms (حد ۱.۵s). **توجه:** در دو اجرای قبلی (۲۰ نمونه) یک نمونه ~۲s بود و در اجرای ۶۰نمونه‌ای تکرار نشد؛ علتش در M7 پیدا و رفع شد (coordinator: جواب فوری long-poll با خبر تازه ۲s منتظر می‌ماند؛ `docs/reports/09-m7-structured-data.md`). LAN واقعی اندازه‌گیری نشد. |
| converge با DocHandle | ۵۰ seed × ۲۰۰۰ op × ۳ replica با crash و خطای شبکه (۱۰۰٬۰۰۰ op، ۱۰۲۱ درخواست گم‌شده، ۱۷۴۵ crash): همه همگرا، هیچ op گم یا دوبار نشد |
- آزمون‌ها (`corepack pnpm -r --if-present test`): protocol ۶۵، schema ۲۵، m1-editor ۶، core ۴۱، store-idb ۱۰، converge ۴؛ typecheck تمیز، Go `-race` سبز، Playwright سه موتور ۳۴ سبز و ۲ skip عمدی (`engines.spec` فقط داخل Chromium اجرا می‌شود و اسکریپت مستقل را صدا می‌زند).
- یافته در بنچ: seed کردن ۱۰k صفحه ۵–۱۰s طول می‌کشد (فقط تولید داده؛ در معیار نیست).

## کار نمی‌کند / آزموده نشده
- **Safari/iPhone واقعی، IME واقعی** (فقط WebKit Playwright و کیبورد شبیه‌سازی‌شده)؛ نتیجهٔ **آزمون ۷ روزهٔ M3** هنوز ثبت نشده (مالک).
- جابه‌جایی صفحه فقط بالا/پایین و تغییر والد ساده است (طبق ROADMAP)؛ drag-and-drop نیست.
- با خروج، دادهٔ محلی IndexedDB پاک نمی‌شود (دستگاه مشترک؛ تصمیم در M15).
- Service Worker/cache پوسته نیست (طبق ROADMAP: M13).
- محدودکنندهٔ push سرور (۳۰۰۰ در دقیقه به ازای حساب) harness را با یک حساب واقعی بعد از ~۲۰ seed ۴۲۹ می‌کرد؛ توکن `DEV_TOKEN` (فقط `DEV_MODE`) حالا از آن معاف است (`TestPushLimiterAppliesToAccountsButNotToTheDevToken`). با `--user` (حساب واقعی) هنوز محدود است؛ دسته‌دسته با `--from N --seeds 13` اجرا کنید.
- بنچ فقط روی لپ‌تاپ توسعه (Playwright)، نه گوشی.

## تصمیم‌ها
مطابق ADR-0003 (بند ۵ هر بلوک `data-block-id`، ۶ دروازهٔ sv، ۱۰–۱۱ throttle و compaction) و ADR-0004 (قاعدهٔ چرخه). هیچ تصمیم تازه‌ای بدون ADR گرفته نشد.

## فایل‌های کلیدی
`packages/core/src/{docHandle,pages,tree}.ts` · `packages/editor` · `apps/web/src/{runtime,workspace,WorkspaceView,PageTreeView,EditorPane}.ts*` · `apps/web/tests/{pages.spec.ts,two-engines-pages.mjs}` · `tools/bench/run.mjs` · `tools/converge/src/ops.ts`.

## قدم بعدی دقیق
۱) مالک چک‌لیست `docs/checklists/M5.md` را اجرا می‌کند (و نتیجهٔ ۷ روزهٔ M3 را ثبت می‌کند). ۲) بعد از تأیید: **M6 — دسکتاپ Tauri 2 + SQLite** (`docs/ROADMAP.md` بخش M6؛ ADR-0001 و ADR-0013) یا، چون M7/M8a هم فقط به M5 وابسته‌اند، M7 را بدون Rust شروع کنید؛ ترتیب را مالک تعیین می‌کند. ۳) مسائل باز: ADR-0003 بند ۱۳ و ADR-0001 بند ۶ (معمار).

## ادامه از صفر
```bash
cd /Users/wrangler/Developer/Projects/nevis-next
corepack pnpm install
corepack pnpm test && (cd server && go test -race ./...)
corepack pnpm --filter web exec playwright test      # سه موتور (سرور Go را خودش بالا می‌آورد)
corepack pnpm --filter web test:engines              # Chromium+WebKit؛ نیاز به سرور روی ۸۷۸۷ و vite روی ۵۱۷۴ (corepack pnpm dev:server + corepack pnpm --filter web dev)
corepack pnpm bench:startup                          # بنچ ۱۰k
corepack pnpm converge --seeds 50 --ops 2000        # DocHandle؛ با حساب واقعی: --user NAME --from 1 --seeds 13 (دسته‌دسته)
server/scripts/demo.sh                               # http://localhost:8788
```
