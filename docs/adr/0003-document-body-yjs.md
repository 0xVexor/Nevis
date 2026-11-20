# ADR-0003: بدنهٔ سند با Yjs و قرارداد schema

- وضعیت: **تصمیم‌شده، منتظر spike M1** (go/no-go در M1)
- اطمینان: ۷۰٪ (ریسک اصلی: IME فارسی و باگ‌های undo در y-tiptap)
- تاریخ: 2026-11-20
- مرتبط: ADR-0002، ADR-0008، ADR-0011؛ تحقیق: R1 (همه)، R6 §5، R7 §2، `storage-and-sync-options.md` §B-3؛ legacy: `docs/legacy/0001-editor-choice.md`، `0007-web.md`

## زمینه
- ادیتور TipTap 3 / ProseMirror در React می‌ماند (جهت هر بلوک و جدول RTL در آن حل شده؛ legacy ADR-0001).
- ویرایش هم‌زمان چند دستگاه، و در آینده چند نفر، روی یک سند لازم است.
- `@tiptap/y-tiptap` binding فعال TipTap است؛ peer آن `yjs ^13` است؛ Yjs 14 هنوز RC است (R1 §1-2).
- باگ‌های باز مرتبط: IME و Backspace (#8626)، رشد سند با undo (#8632)، عدم همگرایی split/join/move با undo (#8609)، lift فهرست (#8735) (R1 §1).
- دو گزارش تحقیق نسخهٔ y-tiptap را متفاوت گفته‌اند (3.0.2 و 3.3.1).

## گزینه‌ها
| گزینه | نتیجه |
|---|---|
| **Yjs 13 + `@tiptap/y-tiptap`** | **انتخاب.** بالغ‌ترین binding برای TipTap؛ JS خالص (بدون WASM)؛ سرور می‌تواند بایت‌ها را مات نگه دارد. |
| Loro + `loro-prosemirror` | رد فعلاً: binding کم‌آزموده، WASM. مزیت واقعی (move بومی) ثبت شد؛ بازبینی وقتی y-tiptap در M1 شکست بخورد. |
| Automerge 3 + `@automerge/prosemirror` 0.2 | رد: binding نابالغ (R1 §4). |
| JSON ProseMirror به‌عنوان حالت + diff/merge سفارشی (fallback) | رد به‌عنوان مسیر اصلی (همان heuristicهای قدیمی)؛ **نگه داشته‌شده به‌عنوان fallback** اگر M1 شکست بخورد: کل سند LWW در سطح بلوک بدون هم‌نویسی هم‌زمان. |

## تصمیم
1. **یک `Y.Doc` per موجودیت دارای بدنه**؛ محتوا در `Y.XmlFragment` با نام ثابت `"body"`. هیچ دادهٔ دیگری در این Y.Doc نیست؛ عنوان و متادیتا رجیسترند (ADR-0004) تا فهرست صفحه‌ها بدون بارگذاری Y.Doc ساخته شود.
2. **پین نسخه:** در شروع M1 مهندس `npm view yjs version`، `npm view @tiptap/y-tiptap version` و `npm view @tiptap/core version` را اجرا می‌کند و همهٔ `yjs`، `y-protocols`، `@tiptap/*`، `@tiptap/y-tiptap`، `prosemirror-*` را **دقیق** (بدون `^`) پین می‌کند و در گزارش M1 ثبت می‌کند. انتظار: `yjs` 13.6.x، `@tiptap/y-tiptap` 3.3.x، `@tiptap/*` 3.35.x. ارتقا فقط در یک milestone جدا با آزمون‌های fixture (بند ۸).
3. **Yjs 14** تا وقتی y-tiptap رسماً پشتیبانی نکند و ۳ ماه پایدار نباشد استفاده نمی‌شود. چون لاگ updateهای V1 نگه می‌دارد، مهاجرت = بازرمزگذاری snapshot هر سند در یک milestone جدا.
4. **قالب بایت:** همه‌جا **update نسخهٔ V1** (`encodeStateAsUpdate`، نه V2). V2 فشرده‌تر است ولی yrs در decode V2 باگ باز دارد (R1 §3، y-crdt#758) و فشرده‌سازی HTTP بیشتر فاصله را جبران می‌کند.
5. **قرارداد attribute (قاعدهٔ سخت):**
   - هر attribute در schema یک **پیش‌فرض غیر `null`** دارد. `null` هرگز مقدار attribute نیست. دلیل: yjs مقدار `null` را نمی‌نویسد و پیش‌فرض‌ها را می‌نویسد (legacy ADR-0007)؛ پس «نبودن» و «پیش‌فرض» باید یک معنا داشته باشند.
   - مقدار attribute فقط `string`، عدد صحیح، یا `boolean`. شیء و آرایه ممنوع (اگر لازم شد، رشتهٔ JSON با نام `...Json`).
   - **`dir`**: `"auto" | "rtl" | "ltr"`، پیش‌فرض `"auto"`، روی همهٔ بلوک‌های متنی و `table`. استثناهای render از legacy ADR-0001 می‌مانند (`dir=auto` روی `<p>` درون `<li>`/`<td>` نوشته نمی‌شود).
   - **`blockId`**: UUIDv7، پیش‌فرض `""`، روی همهٔ گره‌های بلوکی (فهرست دقیق در `packages/schema`). یک plugin بعد از **هر** تراکنش (محلی و دوردست) بلوک‌های بدون id یا تکراری را اصلاح می‌کند: به ترتیب سند، اولین رخداد id را نگه می‌دارد و بقیه id تازه می‌گیرند. اگر دو دستگاه هم‌زمان اصلاح کنند، LWW داخلی Yjs روی attribute همگرا می‌کند. copy/paste همیشه id تازه می‌دهد.
6. **schema ناشناخته:** سندی که `max_sv` آن از `sv` کلاینت بیشتر است در ادیتور باز نمی‌شود (فقط‌خواندنی با پیام «به‌روزرسانی لازم»). دلیل: رفتار y-prosemirror با گره ناشناخته تأیید نشده (R6 §5) و ممکن است محتوا را حذف کند.
7. **هرگز Y.Doc را از JSON ProseMirror دوباره نساز** برای سندی که جای دیگری وجود دارد (Hocuspocus هشدار تکرار محتوا می‌دهد؛ R4 §7). ساختن از JSON فقط برای «سند تازه با شناسهٔ تازه» مجاز است: import (ADR-0009) و ساخت از قالب.
8. **برابری = برابری projection، نه بایت.** `project(doc)` = JSON ProseMirror با پیش‌فرض‌های schema. آزمون‌های همگرایی و fixture همه روی projection. fixtureهای طلایی: مجموعه‌ای از updateهای V1 ذخیره‌شده در مخزن که باید پس از هر ارتقای نسخه به همان projection برسند.
9. **schema بدون DOM:** `packages/schema` در Node بدون jsdom بارگذاری می‌شود و هم ادیتور و هم هسته (projection، استخراج متن و لینک) از آن استفاده می‌کنند.
10. **ادغام updateهای محلی:** updateهای Yjs در حافظه جمع و با `Y.mergeUpdates` یکی می‌شوند و حداکثر هر **۳۰۰ms**، و فوراً در `visibilitychange` (hidden)، `pagehide` و بستن سند، در یک تراکنش (`doc_update` + `outbox`) نوشته می‌شوند. پنجرهٔ از دست رفتن در crash ≤ ۳۰۰ms.
11. **GC و compaction محلی:** `gc: true` همیشه. هر وقت `doc_update`های یک سند > ۲۰۰ ردیف یا > ۱MB شد، هسته state کامل را بازسازی و در `doc_state` می‌نویسد و ردیف‌های ادغام‌شده را در همان تراکنش حذف می‌کند. snapshot سروری: ADR-0005.
12. **undo:** UndoManager فقط origin محلی را دنبال می‌کند؛ پشتهٔ undo هرگز ذخیره نمی‌شود و با بستن سند پاک می‌شود (برای مهار رشد #8632).
13. **IME:** اگر M1 نشان دهد update دوردست وسط composition آن را می‌شکند، راهکار مشخص: صف کردن updateهای دوردست برای سند باز تا `compositionend` (حداکثر ۲ ثانیه). این راهکار جزو دامنهٔ M1 است.
14. **جابه‌جایی بلوک** = حذف + درج (Yjs move ندارد). ویرایش هم‌زمان روی بلوکِ در حال جابه‌جایی ممکن است تکرار یا گم شود؛ پذیرفته و مستند شد.

## پیامدها
- ادیتور قدیمی باید با `Collaboration` و `UndoRedo` از y-tiptap کار کند؛ history خود TipTap حذف می‌شود.
- اندازهٔ هر سند رشد می‌کند؛ compaction محلی و snapshot سروری لازم است.

## چه چیزی تصمیم را برمی‌گرداند (M1)
| معیار رد | آزمون |
|---|---|
| تایپ فارسی با IME در Chrome و Safari macOS، با رسیدن update دوردست هر ۲۰۰ms، composition را قطع کند یا caret بپرد، حتی با راهکار بند ۱۳ | چک‌لیست دستی مالک + آزمون CDP composition در Chromium |
| fuzz (split/join/lift/move + undo، ۲ replica، ۲۰۰ seed × ۵۰۰ گام): (الف) projection دو **Y.Doc** حتی در یک seed متفاوت باشد؛ یا (ب) «view ادیتور ≠ Y.Doc خودش» بدون undo در > ۱٪ و با undo در > ۵٪ seedها رخ دهد و بازسازی view آن را درست نکند | `pnpm --filter m1-editor test:fuzz` (جزئیات در ROADMAP M1) |
| اندازهٔ سند ۱۰۰ پاراگراف بعد از ۳۰ چرخهٔ undo/redo > ۲MB | آزمون خودکار در M1 |
| `dir` یا جدول RTL بعد از round-trip از Yjs از دست برود | آزمون projection |
اگر رد شد: (الف) نسخهٔ دیگر y-tiptap یا `y-prosemirror` مستقیم؛ (ب) اگر باز رد شد، fallback «JSON + LWW در سطح بلوک» و بازنویسی این ADR.
