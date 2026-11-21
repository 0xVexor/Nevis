# گزارش 11: M8b — انتقال UI قدیمی (اپ کامل)

- تاریخ: 2026-11-21 · تگ: `m8b` · `SV` همچنان **۲** (M8b هیچ گرهٔ تازه‌ای به schema نیاورد)
- هدف: تجربهٔ اپ قدیمی روی هستهٔ جدید. **نقطهٔ برش (دو بخش، یک جلسه):** بخش ۱ = قواعد معماری + سیستم طراحی + i18n + تنظیمات + پوسته (خانه، همهٔ صفحه‌ها، قالب‌ها، تنظیمات، palette، میانبرها)؛ بخش ۲ = نماهای پایگاه‌داده (چند نما، مرتب‌سازی، ستون‌های پنهان، board) و قالب config نما.
- وضعیت: **بخش خودکار کامل و سبز.** «همان حس اپ قدیمی» و iPhone واقعی با مالک (`docs/checklists/M8b.md`)؛ ما حس را خودکار نمی‌سنجیم.

## روش: ظاهر را کپی کردیم، فقط آنچه به داده می‌خورد بازنویسی شد
فایل‌های `src/` قدیمی (به‌جز `editor/`) از نظر import دسته‌بندی شدند: **۲۷۴ فایل / ۳۷٬۶۸۳ خط «نمایشی»** (به لایهٔ داده قدیمی import ندارند) و **۱۰۴ فایل / ۲۳٬۲۱۲ خط «وابسته به داده»** (store، repo، db، kvStore، sync، vault، ...). سیستم طراحی (`design-system/`، یکی از «نمایشی»‌ها) با همان توکن‌ها و کامپوننت‌ها کپی و تطبیق داده شد؛ کامپوننت‌های وابسته به داده از نو روی API هسته نوشته شدند.

## قواعد معماری (پیش از کپی هر کامپوننت)
- `.dependency-cruiser.cjs` + `corepack pnpm check`: (۱) هیچ import از ماژول‌های ذخیره/سینک قدیمی (`store`، `repo`، `db`، `kvStore`، `saveWorkspace`، `attachments`، `websync`، `autobackup`، `vault`، `conflict`، `backup`) در `apps/web/src`؛ (۲) هیچ import از ریپوی قدیمی؛ (۳) `deviceSettings.ts` نمی‌تواند `@nevis/core` را import کند (پس به log همگام دسترسی ندارد)؛ (۴) بدون وابستگی حلقوی. دامنه فقط `apps/web/src` است (`packages/core/src/store.ts` رابط **جدید** است و گرفتار نمی‌شود). **غیرتوخالی بودن:** `tools/depcheck/test.mjs` پوشهٔ fixture‌ای را که عمداً قاعده را می‌شکند می‌سنجد و باید رد کند (اجرا شده: «fixture رد شد»).
- قاعدهٔ حلقوی یک **حلقهٔ واقعی در طراحی قدیمی** پیدا کرد (`Menu` ↔ `useMenu`)؛ `Dropdown` به فایل خودش رفت.

## نتایج (اجرا شده)
| معیار ROADMAP | نتیجه |
|---|---|
| e2e مسیرهای اصلی در Chromium و WebKit | `shell.spec.ts`، `views.spec.ts`، `mobile.spec.ts` + همهٔ آزمون‌های قبلی (همان `data-testid`ها حفظ شد؛ تور اطمینان): **Playwright سه موتور ۸۱ سبز، ۹ skip عمدی** (۲ `engines.spec`، ۳ paste در Firefox، ۲ درگ در WebKit/Firefox، ۲ موبایل در غیر WebKit)؛ مسیرها: ساخت صفحه، درخت، زیرصفحه، سطل و بازگردانی، پیوند عمیق و reload، قالب، پایگاه‌داده، تنظیمات، palette |
| بدون import از کد قدیمی (`dependency-cruiser`) | `pnpm check` سبز (۱۷۸ ماژول، ۴۲۹ وابستگی، ۰ تخلف) و غیرتوخالی (بالا) |
| تنظیمات دستگاه هرگز در outbox نیستند | `shell.spec.ts`: از **خود صفحهٔ تنظیمات** هر تنظیم دستگاه (تم، اندازهٔ متن، عرض نوار، رنگ) عوض می‌شود؛ **head لاگ سرور و outbox بدون تغییر** (۱٫۵ ثانیه صبر برای هر چیزی که قرار بود نوشته شود)؛ reload: تنظیم می‌ماند (localStorage). **کنترل:** یک تنظیم **همگام** (تقویم) head را **دقیقاً یک** بالا می‌برد (پس آزمون توخالی نیست) |
| نماهای پایگاه‌داده روی مدل M7 | چند نما (جدول و برد)، مرتب‌سازی (عدد دقیق، فارسی، select به ترتیب گزینه، خالی همیشه آخر)، ستون‌های پنهان، گروه‌بندی board، **جابه‌جایی کارت با کشیدن = یک op** (مقدار select و `sortKey` با هم؛ آزمون: head دقیقاً +۱)، «انتقال به» برای لمس، افزودن کارت در ستون، config بعد از reload می‌ماند (سه موتور؛ درگ واقعی فقط Chromium) |
| ۱۰k صفحه | خانه فقط ۸ تازه‌ترین را (یک گذر)، «همهٔ صفحه‌ها» صفحه‌به‌صفحه (۵۰ ردیف)، palette حداکثر ۲۰ نتیجه؛ آزمون با **۳۰۰۰ صفحه** (نه ۱۰k: زمان seed): همان ۸ و ۵۰ ردیف و صفحه‌بندی «۳۰۰۰»؛ `bench:startup` با ۱۰k صفحه: لیست قابل‌استفاده Chromium ۲۹۴ms، WebKit ۲۰۷ms، Firefox ۳۰۵ms (حد ۲s)، باز کردن صفحه p95 ۳۶/۲۷/۲۶ms |
| واکنش‌گرا و لمسی | `mobile.spec.ts` (WebKit، viewport ۳۹۰×۸۴۴ با touch و `isMobile`): نوار کنار منوی کشویی، صفحه‌نوشتن فارسی، تنظیمات، همهٔ صفحه‌ها؛ **بدون اسکرول افقی** (در سه صفحه)، هیچ دکمه‌ای کوتاه‌تر از ۲۴px نیست (دکمهٔ twist درخت را درشت کرد) |
| دسکتاپ | `apps/desktop/scripts/ui.mjs` (UI واقعی در WebView دسکتاپ، شامل «همهٔ بلوک‌ها») سبز |
| آزمون‌های واحد | core ۸۱ (جدید: `viewConfig.test.ts` با fast-check)، بقیه بدون تغییر؛ typecheck تمیز |

## تصمیم‌ها و انحراف‌ها (نیازمند تأیید)
- **تنظیمات دستگاه در `localStorage`، نه `meta` ذخیره‌گاه** (انحراف از ADR-0002 «meta محلی»): یک دستگاه چند workspace دارد و تم باید پیش از ورود و پیش از باز شدن هر پایگاه workspace اعمال شود. در `deviceSettings.ts` و بالای همان فایل ثبت شده.
- **قالب `view.config` نسخه‌دار و بردبار** (`packages/core/src/viewConfig.ts`، سند: `docs/formats/records-v1.md`): `{v, groupBy, sort, hidden}`؛ ناخوانا = پیش‌فرض؛ فیلد ناشناخته حفظ می‌شود؛ `groupBy` ناموجود = بدون گروه‌بندی؛ فیلتر هنوز نیست (M10).
- **بدون گرهٔ تازه در schema** (`SV = 2`): `databaseEmbed` و `inlineIcon` (گره‌های تازه) به یک milestone بعدی با `SV = 3` و fixture می‌روند.
- سطل زباله فقط **بازگردانی** دارد؛ «خالی کردن» (purge) با M13. palette فقط عنوان صفحه را با `normalizeFa` می‌گردد (بدون ایندکس؛ جست‌وجو M10).
- میانبرهای سراسری با **کلید فیزیکی** (`event.code`): ⌘/Ctrl+K، Alt+N، Alt+H؛ با کیبورد فارسی هم کار می‌کنند.

## جدول کامپوننت‌های قدیمی
**آورده شد (کپی و تطبیق):** `design-system/` (۴۴ فایل: توکن‌ها، `Button`، `Menu`، `Popover`، `Toast`، `SearchPalette`، `Preferences`، `Panel`، `Row`، آیکن‌ها، ...؛ بدون `Gallery` و CSS legacy) · `iconSet*.ts` · `textDirection.ts` · `fa.ts` و `fa-settings.ts` (ترجمه‌های فارسی؛ ۱٬۶۲۴ خط).
**بازنویسی روی هستهٔ جدید:** `Home*` ← `views/Home.tsx` (سلام، میانبرها، تازه‌ترین‌ها) · `Explorer`/`PagesTable` ← `views/AllPages.tsx` (جست‌وجو، صفحه‌بندی) · `PageTree` ← `PageTreeView` (M5) · `PageView` ← `EditorPane` · `Databases`/`database/ui` (جدول) ← `DatabaseView` + `ViewBar` · `BoardView` ← `BoardView.tsx` · `SettingsPage` ← `views/Settings.tsx` (تفکیک «این دستگاه» / «همگام»، فهرست میانبرها) · `Trash` ← فهرست سطل در نوار کنار + بازگردانی · `TemplateGallery` ← `views/Templates.tsx` (۵ قالب) · `commandPalette`/`shortcuts` ← `views/Palette.tsx` + میانبرهای سراسری.
**نیامده (و دلیل):** `Vaults`، `VaultPicker`، `VaultSwitcher`، `DesktopFrame` (مدل vault قدیمی؛ جایش انتخاب workspace M4) · `Flashcards`، `History`، `reviewlog*` (M11) · `GraphView`، `graph*`، `searchIndex`، `pageIndex` (M10) · `Tasks`، `taskProjects` (M10/M11: فهرست تسک مشتق) · `DataTab`، `autobackup`، `backup/`، `importPlan`، `io.ts` (M12/M13) · `UpdateUI`، `releaseFeatures` (M15) · `mcp/` (M14) · `Cover`، `Brand`، `HomeNote`/`homeLines`/`scenery` تصویری، `PageIcon`/`PageIconPicker` (آیکن و کاور صفحه: رجیستر `icon`/`cover` هست ولی UI ندارد) · `SidebarTags`، `PageLinkPicker` (برچسب در UI؛ `[[` در ادیتور هست) · `onboarding/` · `ReaderBar`، `print.ts`، `textZoom` (بعداً) · از `database/`: `formula/`، `workflows/`، `forms`، `ScheduleViews`، `MapView`، `DashboardView`، `query/chart`، `providers/connected`، `csv`، `PropertyEditor` کامل (خارج از M7: فرمول، workflow، فرم، نقشه، داشبورد؛ OPEN-QUESTIONS ۱۱) · `Toolbar.tsx` (نوار ابزار بالای ادیتور: نوار شناور جایش را گرفته).
**قطعی:** از ۱۰۴ فایل وابسته به داده هیچ‌کدام کپی نشد.

## اصلاحیهٔ بعد از بازبینی (مهم؛ تگ `m8b` هنوز زده نشده)
- `pnpm check` در گزارش اولیه «سبز» اعلام شد ولی با exit 127 شکست می‌خورد (`pnpm` سراسری نبود): **رفع شد** (همهٔ اسکریپت‌ها `corepack pnpm`)؛ حالا `check`، `typecheck`، `test`، `test:go`، `converge`، `desktop build:web`، `test:conformance` با exit 0 اجرا شدند.
- **ظاهر را دیدم (screenshot):** حالت تیره کادر نکته، سربرگ جدول و ستون‌های board را روشن-روی-روشن و ناخوانا می‌کرد، فرمول‌ها در صفحهٔ RTL آینه‌ای نمایش داده می‌شدند، و دکمه‌های «اخیر» در خانه حاشیهٔ خام داشتند. رفع: رنگ‌ها با توکن‌های `--ds-*`، فرمول/نمودار `direction: ltr`، سبک دکمه‌های فهرست؛ آزمون تازهٔ **کنتراست WCAG AA در حالت تیره** (کادر نکته، سربرگ جدول، منوی slash، نوار شناور، palette، ستون board، با **کنترل**: باگ قدیمی تزریق می‌شود و باید گرفته شود؛ سه موتور سبز).
- **بسته شد:** نوار کنار حالا حداکثر ۲۰۰ ریشه + «نمایش بیشتر» را رندر می‌کند و آزمون با ۳۰۰۰ ریشهٔ **تخت** سقف را assert می‌کند (≤۲۰۰ ردیف، بعد ≤۴۰۰؛ سه موتور)؛ `test:engines` (چهار اسکریپت دو موتوری)، `prod-csp-blocks.mjs` (سه موتور) و `ui.mjs` دسکتاپ بعد از پوستهٔ جدید دوباره اجرا و سبز شدند؛ ردیف تنظیم `weekStart` حذف شد و `calendar` حالا ستون تاریخ پایگاه‌داده را هم عوض می‌کند؛ لینک عمیق به صفحهٔ حذف‌شده پیام درست می‌دهد؛ `playwright.m8.config.ts` عمداً نگه داشته شد (fuzz روی پورت آزاد). **باز:** ۱۰k ریشهٔ تخت فقط با ۳۰۰۰ در UI سنجیده شد، نه ۱۰k کامل؛ `crash.spec` در Firefox یک بار زیر بار شکست خورد و در اجرای تنها سبز بود (احتمالاً flake).

## کار نمی‌کند / آزموده نشده (صادقانه)
- **«همان حس اپ قدیمی» را ما نمی‌توانیم بسنجیم:** ظاهر (توکن‌ها، کامپوننت‌ها، فونت) کپی شد، ولی چیدمان صفحه‌ها (خانه با منظره، کاورها، پیام‌های روزانه، انیمیشن‌ها) ساده‌تر است. **فهرست تفاوت‌ها با مالک** (چک‌لیست ۱ و ۱۰).
- **iPhone واقعی و Safari** آزموده نشد (فقط WebKit Playwright با پروفایل لمسی).
- آیکن/کاور صفحه، برچسب‌ها، فلش‌کارت، گراف، تسک، فیلتر نما، ستون‌های قابل‌تغییر اندازه، drag-reorder ستون/ردیف، ویرایش رنگ گزینه در UI: نیامده.
- درگ HTML5 فقط در Chromium خودکار آزموده می‌شود؛ WebKit و Firefox با «انتقال به» (منو) آزموده شدند.
- آزمون ۱۰k در UI با ۳۰۰۰ صفحه است؛ خود ۱۰k فقط در `bench:startup`.
- متن‌های ترجمه‌نشده (کلیدهای انگلیسی بدون ورودی در `fa*.ts`) انگلیسی نمایش داده می‌شوند (همان قرارداد قدیمی).

## فایل‌های کلیدی
`apps/web/src/{WorkspaceView,deviceSettings,workspaceSettings,router,BoardView,DatabaseView}.tsx|ts` · `apps/web/src/views/*` · `apps/web/src/ds/*` · `apps/web/src/i18n/*` · `packages/core/src/viewConfig.ts` · `.dependency-cruiser.cjs` · `tools/depcheck/` · `apps/web/tests/{shell,views,mobile}.spec.ts`.

## قدم بعدی دقیق
M9 — پیوست‌ها و blob (`docs/ROADMAP.md` بخش M9): ذخیرهٔ فایل محتوا-آدرس‌دار، تصویر واقعی در بلوک `image`، فایل در نقاشی، حذف سقف ۲۵۶KB scene. نیازمند `SV` بالاتر اگر attribute تازه لازم شود.

## ادامه از صفر
```bash
cd /Users/wrangler/Developer/Projects/nevis-next
corepack pnpm install
corepack pnpm check                                    # قواعد معماری + اثبات غیرتوخالی + typecheck
corepack pnpm -r --if-present test && (cd server && go test -race ./...)
(cd apps/web && npx playwright test)                   # سه موتور (سرور را خودش بالا می‌آورد)
node apps/desktop/scripts/ui.mjs                       # دسکتاپ
```
