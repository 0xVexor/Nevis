# گزارش 10: M8a — انتقال ادیتور قدیمی (همهٔ بلوک‌ها)

- تاریخ: 2026-11-21 · تگ: `m8a` · مقدار نهایی **`SV = 2`** (فقط در `packages/protocol/src/version.ts`)
- هدف: ادیتور کامل قدیمی روی Yjs، بلوک به بلوک، با قرارداد attribute ADR-0003 §5.
- وضعیت: **بخش خودکار کامل و سبز.** Safari/iPhone واقعی، IME واقعی، paste واقعی از Word/چت و Windows با مالک (`docs/checklists/M8a.md`).

## چه ساخته شد
- **`packages/schema`** (بدون DOM): `blocks.ts` (callout، toggle، layoutGroup/layoutColumn، mathBlock/mathInline، mermaid، drawing، image، pageLink)، attributeهای تازهٔ `textAlign`، `tableAlign`، `tableWidth`، `dir` روی کانتینرها، markهای strike/underline، `isSafeHref`/`safeImageSrc`، `auditSchema` (آزمون قرارداد ADR-0003 §5).
- **`packages/editor`**: node viewها (callout، toggle، ستون‌ها، KaTeX، Mermaid، Excalidraw، تصویر، پیوند صفحه، کد با lowlight و انتخاب زبان)، فرمان‌ها (درج هر بلوک، جهت، تراز، چیدمان جدول، عرض ستون)، منوی `/` و `[[`، نوار شناور متن و جدول، find فارسی، paste (Markdown و HTML پاک‌شده)، جهت خودکار، دستگیرهٔ جابه‌جایی (افزونهٔ رسمی TipTap)، صفحهٔ «همهٔ بلوک‌ها».
- **`packages/core`/زیرساخت** (نیاز مسیر): یک ثابت `SV`؛ محافظت از op بزرگ؛ حسابداری `unsaved` در حال نوشتن؛ سقف حجم batch.
- fixtureهای طلایی (`packages/schema/fixtures`)، fuzz M1 با بلوک‌های تازه، e2e هر بلوک و paste، بررسی CSP تولیدی، همهٔ اینها در دسکتاپ هم.

## نتایج (اجرا شده)
| معیار ROADMAP | نتیجه |
|---|---|
| fixture طلایی هر بلوک round-trip | ۱۲ fixture sv2 (callout، toggle، layout، math، mermaid، drawing، image، pageLink، alignment، tableLayout، containerDir، marksV2) از طریق Yjs بدون تغییر برمی‌گردند؛ ۱۲ fixture sv1 (۱۰ ساختگی + ۲ **واقعی**: صفحهٔ M5 با state فشرده + ۲۰ update دنباله و UUID واقعی) **با schema جدید همان projection** را می‌دهند (مقایسه با حذف مقدارهای پیش‌فرض؛ SHA-256 هر فایل). `docs/formats/golden-fixtures.md` |
| fuzz M1 با بلوک‌های تازه (درج بلوک در مکان تصادفی، حذف بلوک، تغییر attributeها، عرض ستون، تراز، جهت) | ۳۰۰ seed × ۵۰۰ گام، بدون undo و با undo: **Y.Doc همه برابر (۳۰۰/۳۰۰)، ناهماهنگی view: ۱ و ۰ (حد ۱٪ و ۵٪)، ۰ attribute null، idها معتبر**؛ بدون undo ۰ خطا؛ با undo ۱ تا ۲ خطای `Cannot read properties of undefined (reading 'client')` (همان خانوادهٔ خطای undo در y-tiptap که M1 هم ثبت کرده؛ ۰٫۷٪ seedها؛ معیار آن را نمی‌شمارد). حد معیار: ≤۱٪ و ≤۵٪ |
| آزمون‌های قدیمی منتقل | `direction.test` ← `packages/editor/test/direction.test.ts` (همان موردها)؛ `imageUrl.test` ← `imageUrl.test.ts` (+ قاعدهٔ ذخیره: فقط https)؛ `sceneLoad.test` ← `scene.test.ts` (تطبیق: scene رشتهٔ inline است نه Blob)؛ `blockIdentity.test` ← **جایگزین** با آزمون‌های `BlockIdentity` در `packages/schema` و fuzz (مدل قدیمی `blockIdentityVersion`/`null` را ندارد). همه سبز |
| هیچ attr با null یا شیء | `auditSchema` روی schema داده **و روی schema‌ای که اپ واقعاً با آن می‌نویسد** (`getSchema(editorExtensions())`)؛ آزمون `schema-parity` ثابت می‌کند این دو یکی‌اند (همهٔ گره‌ها و markها: content، group، inline/atom، پیش‌فرض attributeها): خالی؛ آزمون «توخالی نبودن» با schema ساختگی بد (null، شیء، float، بدون default، `dir` غیر auto، بلوک بدون blockId) همه را می‌گیرد |
| e2e درج هر بلوک از slash menu | `blocks.spec.ts` سه موتور: ۱۵ بلوک + فرمول درون‌خطی + رندر (KaTeX، Mermaid، Excalidraw کاملاً از origin خودمان، کد رنگی) + reload و بازگشت؛ دستگیرهٔ جابه‌جایی دیده می‌شود (سه موتور) و **کشیدن واقعی یک بلوک** ترتیب را عوض می‌کند و بعد از reload می‌ماند (فقط Chromium: درگ HTML5 با ماوس اسکریپتی در WebKit و Firefox قابل اتکا نیست؛ چک‌لیست مالک)؛ `paste.spec.ts` (Chromium و WebKit): Markdown کامل (تیتر، فهرست، تسک، callout، toggle، فرمول، نمودار، جدول، کد با زبان)، HTML خطرناک پاک می‌شود، Mermaid خام |
| دمو: ویرایش هم‌زمان callout و جدول | `two-engines-blocks.mjs`: Chromium+WebKit، هر دو آفلاین (نگهبان: دو طرف واقعاً متفاوت)، یکی در callout می‌نویسد و دیگری سلول جدول را ویرایش و ردیف می‌افزاید؛ ۳۲ms بعد از اتصال صفحه‌ها یکسان و هر دو ویرایش هست (جدول ۳ ردیف) |
| باز شدن در دسکتاپ | `apps/desktop/scripts/ui.mjs` (فاز ۴): «همهٔ بلوک‌ها» در WebView واقعی دسکتاپ و زیر CSP خودش: همه رندر می‌شوند؛ `selftest` ۱۶/۱۶؛ `converge.mjs` سبز |
| بدون CDN، CSP سخت | `prod-csp-blocks.mjs`: build تولیدی زیر CSP سرور در سه موتور: همهٔ بلوک‌ها رندر، ۰ خطای console، ۰ نقض CSP، هیچ درخواستی به origin دیگر |
| آزمون‌ها | protocol ۶۵، schema ۷۹، editor ۱۸، core ۷۴، store-idb ۱۰، converge ۴، Go (`-race`) سبز؛ Playwright سه موتور ۵۲ سبز و ۵ skip عمدی (۲ `engines.spec`، ۳ paste در Firefox)؛ `test:engines` چهار اسکریپت دو موتوری سبز؛ typecheck تمیز؛ `bench:startup` ۱۰k صفحه: لیست قابل‌استفاده Chromium ۲۷۳ms، WebKit ۲۰۱ms، Firefox ۳۶۷ms (حد ۲s؛ باز کردن صفحه p95 ۳۴/۲۸/۲۰ms) |

## باگ‌هایی که این مرحله پیدا و رفع کرد
0. افزونهٔ `excalidrawNoCdn` اگر رشتهٔ CDN در نسخه‌ای تازه تغییر کند **build را شکست می‌دهد** (آزموده: وقتی رشته پیدا نشود build با خطا تمام می‌شود).
1. **op مسموم (مهم):** یک op بزرگ‌تر از ۱٫۵M نویسه را سرور برای همیشه رد می‌کند (400 دائمی برای کل batch) و موتور برای همیشه دوباره می‌فرستاد؛ پس **همهٔ تغییرات بعدی** پشت آن می‌ماند. رفع: `OpTooLargeError` پیش از نوشتن؛ `DocHandle` با `onTooLarge`/`diverged` (و ادیتور فقط‌خواندنی با دکمهٔ «باز کردن دوباره»)؛ موتور بعد از `bad_envelope` opها را یکی‌یکی می‌فرستد و opِ رد‌شده را به quarantine می‌برد (فقط همین کد: 426، 413، 409، 422 و `bad_request` هرگز quarantine نمی‌شوند)؛ batch بر اساس حجم محدود می‌شود (413 دائمی).
2. **`DocHandle.unsaved` وقتی نوشتن در جریان است صفر بود** (یعنی «همه ذخیره شد» وسط نوشتن؛ reload در آن لحظه ویرایش را می‌برد). رفع و آزمون.
3. **`sortKeyBetween`** (از M7).
4. **زبان بلوک کد از Markdown/HTML خوانده نمی‌شد** (override من attribute اصلی را برداشته بود): رفع در schema.
5. **Excalidraw یک آدرس CDN (esm.sh) را آخرین جای جست‌وجوی فونت می‌گذارد** (نقض CSP و آدرس شخص ثالث در bundle): در build به origin خودمان بازنویسی می‌شود.
6. منوها (`/`، `[[`) بعد از بسته شدن در DOM می‌ماندند (نشت)؛ رفع.

## تغییر attributeها نسبت به قدیم
| قدیم | جدید | چرا |
|---|---|---|
| callout `emoji` | `icon` (رشتهٔ نام نماد) | مقدار قدیمی emoji یا نام بود؛ نام نگه داشته شد (نگاشت emoji→نام در paste و در import M12) |
| layout `widths` (آرایهٔ JSON روی گروه، `null` پیش‌فرض) | `layoutColumn.width` (عدد صحیح، ۰ = سهم برابر) | آرایه ممنوع؛ ویرایش هم‌زمان دو ستون ادغام می‌شود |
| layout `direction` (`null`/rtl/ltr) | `dir` استاندارد (`auto`/rtl/ltr) روی `layoutGroup` | |
| drawing `scene` (id پیوست) و `preview` (data URL) | `scene` رشتهٔ JSON ≤ ۲۵۶KB، `preview` حذف | پیش‌نمایش از scene روی صفحه کشیده می‌شود؛ سقف در `writeScene` (قبل از نوشتن)؛ تا M9 |
| image `src` (هر چیز، `null` پیش‌فرض) | `src` فقط `''` (جای‌گیر) یا https؛ `width` ۰..۱۰۰ (درصد)، `align` ''/start/center/end، `motion` ''/loop | `data:` هرگز در attribute نمی‌رود؛ فایل‌ها M9 |
| pageLink `id`، `label: null` | `dstId`، `label: ''` | |
| `textAlign`/`tableAlign: null`، `tableWidth: null` | `''` / `''` / `0` | |
| `dir` فقط روی LEAF و چند کانتینر | `dir` روی paragraph، heading، table، blockquote، listItem، taskItem، tableCell، tableHeader، layoutGroup | |
| strike/underline (در M1 بیرون گذاشته شده بود) | به schema برگشتند (mark بدون attribute) | امکان قدیمی؛ جزو تصمیم این مرحله |

## جدول همهٔ ۵۷ فایل `src/editor/` قدیمی
**آورده شد** (بازنویسی برای مدل جدید): `blocks.ts` (callout، toggle) · `layout.ts` (schema + node view + درج/باز کردن/عرض؛ بدون کشیدن عرض) · `layoutModel.ts` (ساختار را schema تضمین می‌کند) · `math.ts` · `mermaid.ts` · `mermaidText.ts` · `drawing.ts` · `excalidraw.ts` · `sceneLoad.ts` (+ test) · `persianFont.ts` · `codeBlock.ts` (lowlight + انتخاب زبان) · `image.ts` (جای‌گیر/https) · `imageUrl.ts` (+ test) · `pageLink.ts` · `slash.ts` · `menu.ts` · `find.ts` · `markdownPaste.ts` · `headingDir.ts` (+ `direction.test`) · `extensions.ts` (جهت، تراز، فرمان‌های جدول) · `blockIdentity.ts` (+ test؛ مدل جدید در `packages/schema` از M1).
**جایگزین شد**: `dragHandle.ts` (۱٬۳۱۲ خط) ← افزونهٔ رسمی `@tiptap/extension-drag-handle` · `htmlToDoc.ts`، `contentSafety.ts` ← `paste.ts` پاک‌سازی + `auditSchema` + دروازهٔ `sv` · `linkPrompt.ts` ← ورودی پیوند در نوار شناور با `isSafeHref` · `langMenu.ts` ← `<select>` · `excalidrawAssets.ts` ← افزونهٔ Vite که فونت‌ها را از `node_modules` به `/excalidraw-assets` کپی می‌کند · `documentCommitGuard.ts` (+ test) ← `DocHandle` و `OpTooLargeError` (مدل ذخیرهٔ قدیمی را نداریم).
**بعداً / M8b** (رابط و سیستم طراحی): `commandPalette.ts` · `databaseEmbed.ts` (نیاز به نماهای M7 در UI) · `inlineIcon.ts` و `iconSet` (مجموعه نماد M8b) · `menuIcons.ts`، `svgIcons.ts` · `physicalShortcuts.ts` (میانبرهای قابل‌تنظیم = تنظیمات M8b) · `textZoom.ts` (ظاهر) · `lightbox.ts` (با پیوست‌ها M9).
**بعداً (ادیتور، بدون ضرورت برای معیار)**: `snapHover.ts`، `snapModel.ts`، `snapSurface.ts`، `snapTargets.ts`، `layoutEditing.ts`، `layoutInteraction.ts`، `layoutNavigation.ts` (کشیدن عرض ستون و درگ بخش‌ها با snap؛ فرمان `setColumnWidths` آماده است) · `tableResize.ts` (نیاز به طراحی attribute `colwidth` بدون آرایه) · `tableHeader.ts` · `expandSelection.ts` · `flowArrows.ts` · `markdownTab.ts` · `slashPreview.ts` · `detect.ts` (تشخیص خودکار زبان کد) · `insertionAnchor.ts`، `useAnchor.ts` (کمک‌های React قدیمی).

## کار نمی‌کند / آزموده نشده (صادقانه)
- **Safari/iPhone واقعی، IME فارسی واقعی، paste واقعی از Word و چت، Windows:** با مالک (چک‌لیست).
- **paste در Firefox خودکار آزموده نشد:** `new ClipboardEvent(..., {clipboardData})` در Firefox نادیده گرفته می‌شود؛ Chromium و WebKit آزموده شدند.
- **باگ ساختاری که fuzz پیدا کرد و تا حدی رفع شد:** درج یک بلوک **وسط متن یا جایگزین یک پاراگراف خالی** (و paste چندبلوکی) درون ساختارها (سلول جدول، فهرست، callout) در ۸ تا ۱۹٪ seedها Y.Doc‌ای ساخت که ادیتور آن را متفاوت از ساختار ذخیره‌شده نشان می‌داد (rerender هم درست نمی‌کرد؛ یعنی ساختار ذخیره‌شده خودش ناجور بود). (نتیجهٔ اولیهٔ «۰ از ۶۰۰» **اشتباه** بود: آزمون را به مسیر امن محدود کرده بودم نه برنامه را.) **رفع (فرمان‌های درج بلوک در `commands.ts`):** هیچ‌گاه وسط متن؛ روی خط خالی بلوک **قبل** از خط خالی می‌نشیند و جایگزین یا حذفش نمی‌کند؛ روی خطی که متن دارد اول Enter در انتهای خط و بلوک روی خط تازه (دو گام جدا، نه یک تراکنش مرکب: اندازه‌گیری شد). درج در **مکان تصادفی** (فرمان‌ها همهٔ مسیرها را می‌گیرند): **۳۰۰ seed بدون undo: ۱ ناهماهنگی (۰٫۳٪)؛ با undo: ۰ (حد: ≤۱٪ و ≤۵٪)**. علت ریشه‌ای (به‌نظر: حذف یا جایگزینی پاراگراف در ساختارهای تودرتو در y-tiptap/prosemirror-tables) **بررسی نشد**.
- **باز (paste چندبلوکی در مکان تصادفی):** با paste پیش‌فرض ProseMirror در آزمون فشار (`FUZZ_PASTE=1`، یک شانزدهم گام‌ها) **۷ از ۳۰۰ (۲٫۳٪) و ۶ از ۳۰۰ (۲٫۰٪)** ناهماهنگی؛ یک رفع ساده (Enter در انتهای خط و `replaceSelection` روی خط تازه) **بدتر** شد (۸ و ۸) و برگردانده شد. معیار M1 را نمی‌شکند چون paste جزو گام‌های معیار نیست، ولی **باگ باز است**: paste چندبلوکی وسط یک سلول یا فهرست ممکن است ساختار ذخیره‌شدهٔ ناجور بسازد. قدم بعدی: ردیابی با seed ثابت.
- کشیدن عرض ستون‌ها و ردیف/ستون جدول با ماوس، تغییر اندازهٔ جدول با کشیدن، دستگیرهٔ جابه‌جایی با snap: نیامده‌اند (جدول فایل‌ها).
- پیوست‌ها (تصویر واقعی، فایل در نقاشی): M9. نقاشی تصویر درون بوم را غیرفعال کرده (`tools.image: false`).
- **تصمیم نیازمند تأیید معمار:** سیاست «یک بار `SV+1` برای هر milestone» (یادداشت در ADR-0002). اگر معمار هر گروه را `SV` جدا بخواهد، `SV` یک ثابت است.
- دستگاه یا تب قدیمی (با `SV = 1`) تغییرات دستگاه‌های جدید را نگه می‌دارد (held) تا به‌روز شود، حتی ویرایش ساده؛ دسکتاپ و وب باید با هم build شوند.

## فایل‌های کلیدی
`packages/schema/src/{blocks,extensions,audit,safeHref}.ts` · `packages/schema/{fixtures,test/golden.test.ts,scripts/capture-golden.ts}` · `packages/editor/src/**` · `packages/core/src/{engine,client,docHandle}.ts` · `apps/web/tests/{blocks,paste}.spec.ts`، `two-engines-blocks.mjs`، `prod-csp-blocks.mjs` · `spikes/m1-editor/src/fuzz.ts` · `apps/desktop/scripts/ui.mjs`.

## قدم بعدی دقیق
M8b — انتقال UI قدیمی (`docs/ROADMAP.md` بخش M8b): Home، PageTree، Explorer، PageView، نماهای پایگاه‌داده، Settings (تفکیک همگام/دستگاه)، Trash، قالب‌ها، command palette، میانبرها، design system، i18n؛ شامل «بعداً/M8b»های جدول بالا (`commandPalette`، `databaseEmbed`، `inlineIcon`، `physicalShortcuts`، `textZoom`).

## ادامه از صفر
```bash
cd /Users/wrangler/Developer/Projects/nevis-next
corepack pnpm install
corepack pnpm -r --if-present test && (cd server && go test -race ./...)
(cd apps/web && npx playwright test)                    # سه موتور
(cd apps/web && corepack pnpm test:engines)             # سرور 8787 (SIGNUPS_PER_HOUR=100000) و vite 5174
(cd apps/web && node tests/prod-csp-blocks.mjs)         # build تولیدی زیر CSP، سه موتور
node apps/desktop/scripts/ui.mjs                        # UI واقعی دسکتاپ + همهٔ بلوک‌ها
(cd spikes/m1-editor && FUZZ_SEEDS=100 npx playwright test)   # fuzz ادیتور
```
