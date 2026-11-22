# import دادهٔ اپ قدیمی

`corepack pnpm nevis import-legacy <pages.json | پوشه> [out.nevis.zip]` ← باندل ← «ورود از باندل» در فهرست workspace.

**ورودی:** آرایهٔ JSON صفحه‌های قدیمی (خروجی `repo.dump()`: `{id, parentId, kind, title, content (TipTap JSON), deletedAt, database}`)؛ در یک پوشه: `pages.json`.

**نگاشت:** پوشه ← موجودیت بدون بدنه با نشانگر همگام `folder:<id>` (در درخت و فایل‌ها پوشه می‌ماند)؛ صفحه ← موجودیت + بدنه؛ `callout.emoji` ← `icon`؛ `layoutGroup.widths/direction` ← `width` هر ستون و `dir`؛ `tableCell/tableHeader.colwidth` ← `colwidthJson`؛ `drawing.preview` حذف و `scene` حفظ؛ `pageLink.id` ← `dstId`، `label` تهی ← ''؛ هر attribute با `null` حذف (schema جدید null ندارد)؛ `blockId` غایب ساخته می‌شود؛ شناسهٔ غیر UUID شناسهٔ تازه می‌گیرد.

**نیامد و در گزارش خروجی می‌آید:** `board` و `deck` (معادل ندارند)، ردیف‌های پایگاه‌داده قدیمی، صفحهٔ حذف‌شده، تصویر `data:` داخل صفحه (شمارش می‌شود)، پیوست‌های قدیمی (قالب blob قدیمی خوانده نمی‌شود).

**صادقانه:** این نگاشت با **دادهٔ ساختگی** آزموده شد (`packages/bundle/test/legacy.test.ts`)؛ **روی دادهٔ واقعی مالک اجرا نشده** (دادهٔ او در این محیط نیست). قبل از تکیه بر آن، یک‌بار روی دادهٔ واقعی اجرا و گزارش خروجی با شمارش صفحه‌ها مقایسه شود (چک‌لیست M12).
