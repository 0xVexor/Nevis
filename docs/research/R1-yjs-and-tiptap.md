# R1 — Yjs و TipTap برای ویرایش مشترک Nevis

تاریخ تحقیق: 2026-11-20. منابع اولیه: npm registry، GitHub API (ریلیزها، کامیت‌ها، issueها)، crates.io. برچسب‌ها: `[source]` = در منبع اولیه خوانده شد؛ `[secondary]` = وبلاگ/snippet جستجو؛ `[inference]` = استنتاج من.

## معنای این برای تصمیم ما

1. `[source]` بسته‌ی جاری TipTap برای bind کردن Yjs `@tiptap/y-tiptap` است (نسخه‌ی latest: 3.3.1، منتشرشده 2026-11-20)؛ `y-prosemirror` از 2025-07-03 (1.3.7) نسخه‌ی پایدار ندارد.
2. `[source]` `@tiptap/extension-collaboration` (3.35.0) peer dependency روی `yjs ^13` دارد. یعنی Yjs 14 در TipTap پشتیبانی‌نشده است.
3. `[source]` Yjs 14 هنوز RC است: `@y/y` نسخه‌ی `14.0.0-rc.30` (2026-11-14) و `yjs` پایدار `13.6.33` (2026-09-23).
4. `[source]` در مخزن `ueberdosis/tiptap` هفته‌های اخیر فعالیت زیادی روی `y-tiptap` هست (کامیت‌های 2026-11-19)، و `y-prosemirror` کامیت‌های v2 (تگ‌های `v2.0.0-15`، 2026-10-11) دارد. آینده‌ی binding ممکن است از دو مسیر بیاید.
5. `[source]` issueهای باز `y-tiptap` که undo را هدف گرفته‌اند: #8632 (رشد document با هر undo/redo تا ~۳۰ MB در مثال کاربر)، #8715 و #8741 (هر کلید در undo جدا می‌شود وقتی collaborator تایپ می‌کند)، #8764 (regression از y-prosemirror در `addToHistory`).
6. `[source]` issue باز #8626 می‌گوید Backspace در وسط IME composition، composition را لغو می‌کند (Keymap هسته یک transaction خالی dispatch می‌کند). این مستقیم به ورودی فارسی مربوط است.
7. `[source]` issue باز #8609 در TipTap: تست fuzz با split/join/move و undo، یک بار از ۴۰ seed خطای `RangeError` داد و در ۴ تا ۵ seed، دو سند همگرا نشدند. همین عملیات روی Yjs خام همگرا بود.
8. `[inference]` پس روی ویژگی‌های اصلی ما (block move، split/join، undo روی همزمانی) ریسک واقعی وجود دارد و باید تست fuzz خودمان را داشته باشیم.
9. `[source]` سند رسمی Yjs می‌گوید tombstoneها تنها وقتی جمع می‌شوند که ترتیبشان دیگر لازم نیست؛ یعنی سند با ویرایش‌ها رشد می‌کند (README).
10. `[secondary]` انجمن Yjs: یک سند حدود ۱۶ MB بیش از ۳۰ ثانیه برای لود روی websocket طول کشیده؛ یک maintainer حدود ۲۰۰ KB را «معقول» دانسته. این اعداد anecdotal هستند.
11. `[source]` Hocuspocus راهنمای رسمی‌اش برای مشکل CPU/memory: چند instance مستقل و تقسیم کاربران بر اساس شناسه‌ی سند؛ حد سند ذکر نشده.
12. `[source]` در Persian/RTL هیچ گزارش مختص y-prosemirror یا y-tiptap پیدا نکردم (بخش ۶ را ببینید).

## ۱. y-tiptap و y-prosemirror

| مورد | وضعیت | منبع |
|---|---|---|
| `@tiptap/y-tiptap` latest | 3.3.1 (2026-11-20)؛ 3.0.0-beta.3 | npm registry `[source]` |
| peer deps y-tiptap | `yjs ^13.6.13`، `prosemirror-view ^1.9.10` و … | npm `[source]` |
| `y-prosemirror` latest | 1.3.7 (2025-07-03) | npm `[source]` |
| مخزن y-prosemirror | آخرین push 2026-11-04؛ ۲۰ issue باز؛ تگ‌های `v2.0.0-x` تا 2.0.0-15 (2026-10-11) | GitHub API `[source]` |
| `@tiptap/extension-collaboration` | 3.35.0 (2026-11-20)؛ peer: `yjs ^13`، `@tiptap/y-tiptap ^3.0.7` | npm `[source]` |
| نگهدارنده | Tiptap (`ueberdosis`) برای y-tiptap؛ y-prosemirror توسط تیم Yjs | `[source]` مخزن‌ها |

**باگ‌های مرتبط با نیازهای ما (تاریخ‌ها از GitHub API):**

| موضوع | Issue | وضعیت (2026-11-20) |
|---|---|---|
| IME: Backspace در composition لغو می‌شود | tiptap #8626 (2026-10-28) | باز |
| undo: هر کلید جدا وقتی collaborator تایپ می‌کند | tiptap #8715 (2026-11-06)، PR #8741 | باز |
| undo: `addToHistory` در meta-only transaction | tiptap #8764 (2026-11-12) | باز |
| undo: رشد سند با undo/redo | tiptap #8632 (2026-10-29)، #8656 | باز |
| split/join/move + undo: RangeError و عدم همگرایی | tiptap #8609 (2026-10-14) | باز |
| جابجایی لیست (lift) جایگزین Yjs element می‌کند و edit همزمان را گم می‌کند | tiptap #8735 (2026-11-10) | باز |
| position tracking در heading | tiptap #8644 | باز |
| restoreRelativeSelection وقتی peer بلاک والد را حذف می‌کند | y-prosemirror #283، #272، #285 | باز |
| mark جابجا می‌شود اما sync نمی‌شود | y-prosemirror #289 (2026-11-04) | باز |
| `updateYText` marks قدیمی را حذف نمی‌کند | y-prosemirror #241 | باز |
| IME (چینی/ژاپنی): sync قبل از compositionend | y-prosemirror #81 (2021-12-06) | بسته |

- `[source]` Issue #81 در y-prosemirror بسته شده و تنها ۵ کامنت دارد؛ این تنها issue مرتبط با IME بود که پیدا کردم.
- `[inference]` چون issueهای undo/IME در TipTap هستند نه y-prosemirror، مسیر bug فعلی TipTap است. وضعیت تعمیر را در ۳۰ روز اخیر باید مرتب پایش کرد.
- `[source]` `Collaboration` و `CollaborationCaret` در `@tiptap/extension-collaboration` و `@tiptap/extension-collaboration-caret` هستند (نسخه 3.35.0)، و `Collaboration` از `@tiptap/y-tiptap` استفاده می‌کند.
- نیازمندی‌های سفارشی (`dir`، `blockId`): **تست نشد**. ADR قبلی ما (`docs/adr/0001-editor-choice.md` در repo قدیمی) می‌گوید dir و جدول RTL با NodeView و `dir=auto` حل شدند، اما روی binding همگام نشده بود.
- `[source]` ADR قبلی ما می‌گوید تست IME واقعی هنوز باز است؛ این تحقیق آن را حل نکرد.

## ۲. Yjs هسته، Yjs 14، و رشد سند

| مورد | یافته | منبع |
|---|---|---|
| نسخه‌ی پایدار | `yjs` 13.6.33 (2026-09-23) | npm/GitHub `[source]` |
| Yjs 14 | `@y/y` 14.0.0-rc.30 (2026-11-14) و rc.29 (2026-10-15)؛ ریلیزهای rc از 2026-09 فعال | GitHub releases `[source]` |
| تغییرات Yjs 14 | یکپارچه‌سازی type ها به `Type` واحد، event system مبتنی بر delta (rc.9)، حذف API وابسته به DOM | `[secondary]` (وبلاگ 2026-04-24، release note قدیمی) |
| فرمت wire در Yjs 14 | **تأیید نشد**. release notes رسمی rc را پیدا نکردم | — |
| فرمت V1/V2 | `encodeStateAsUpdate` و `encodeStateAsUpdateV2`؛ `convertUpdateFormatV1ToV2` | README `[source]` |
| GC | `doc.gc = false` برای نگه داشتن محتوای قدیمی؛ tombstone فقط وقتی جمع می‌شود که ترتیبش لازم نیست | README `[source]` |
| snapshot | README فقط نام می‌برد؛ API جدا توضیح نمی‌دهد | README `[source]` |
| issue مرتبط با حافظه | yjs #741 (2025-10-21): tombstone در map memory leak | GitHub `[source]` |
| issue مرتبط با GC/undo | yjs #818، #809، #833 (undo بعد از GC) | GitHub `[source]` |
| کند شدن GC بزرگ | yjs #541 (2023): apply کند برای update بزرگ | GitHub `[source]` |

- `[source]` ۲۰۲۶ issueهای باز زیادی روی undo و GC در Yjs هست (#809، #818، #833، #843).
- `[secondary]` انجمن: اندازه‌ی `encodeStateAsUpdate` با هر ویرایش بزرگ‌تر می‌شود؛ اعداد مشخص بعد از N ویرایش در منابع اولیه پیدا نکردم.
- **Compaction (re-encode / snapshot+truncate)**: `[inference]` Yjs API برای تغییر هسته‌ای compaction ندارد؛ معمول این است که state نهایی `encodeStateAsUpdate(doc)` را ذخیره کنیم و `gc` را روشن نگه داریم. ولی `gc=true` روی undo اثر دارد. این کار بدون تست ممکن نیست.
- `[inference]` `Y.XmlFragment` و `Y.Text`: y-prosemirror و y-tiptap روی XmlFragment هستند؛ جزئیات فرمت (`null` attrs و ذخیره‌ی mark) را در کد منبع تأیید نکردم.

## ۳. yrs (Rust) در برابر yjs (JS)

- `[source]` crate `yrs` آخرین نسخه‌ی پایدار 0.28.2 (2026-11-19)؛ نسخه‌های 0.28.0 (2026-09-17) و 0.28.1 (2026-11-04).
- `[source]` issue باز `y-crdt/y-crdt#632` با عنوان «Yjs/Yrs incompatibility» (2026-06-24). بدنه‌ی آن را نخواندم.
- `[source]` issue `y-crdt#758` (2026-11-11): کدگذاری v2 با gap در clock یک client قابل decode نیست.
- `[source]` `y-crdt#720`: `encode_state_as_update_v1` در release panic می‌کند.
- `[source]` `y-crdt#756`، `#674`: undo/redo با رفتار متفاوت.
- `[inference]` ضمانت سازگاری بایتی بین yrs و yjs در منابع اولیه پیدا نکردم؛ پیشنهاد: نسخه‌ها را pin کنیم و تست cross-decode داشته باشیم، اگر سرور هم yrs باشد.
- "server-free relay": اگر سرور فقط relay بایتی باشد، yrs لازم نیست (`[inference]`).

## ۴. جایگزین‌ها (Loro، Automerge، Peritext)

| پروژه | نسخه/تاریخ | binding ProseMirror | وضعیت |
|---|---|---|---|
| Loro (`loro-crdt`) | 1.18.0 (2026-11-16) | `loro-prosemirror` | repo آخرین push 2026-08-22؛ ۱۴۵ ستاره؛ npm listing نسخه‌ی 0.4.3 `[secondary]`؛ منتشرشده نسخه‌ی npm پیدا نشد (`[source]` registry 404) |
| Automerge (`@automerge/automerge`) | 3.5.0 (2026-09-16) | `@automerge/prosemirror` 0.2.0 (2026-02-25) | binding در repo آخرین push 2026-02-25؛ ۱۳۱ ستاره |
| Peritext | — | — | پروژه‌ی تحقیقاتی؛ binding ProseMirror جدی پیدا نکردم `[inference]` |
| y-sweet | 0.9.1 (2025-09-16) | — (سرور Yjs) | بدون ریلیز از ۲۰۲۵ |

- `[source]` Loro و Automerge هسته‌ی فعال دارند، ولی bindingهاشان فعالیت کمتری نسبت به TipTap/y-tiptap دارند.
- `[inference]` برای TipTap، Loro/Automerge یعنی ترک TipTap Collaboration و نوشتن binding یا استفاده از binding کم‌تر آزمون‌شده؛ هزینه‌اش بالاست.
- `[source]` Automerge 2.2 rich text (automerge.org) از Peritext الهام گرفته؛ جزئیات اجرا را تأیید نکردم.

## ۵. تولید واقعی

| محصول/پروژه | داده | منبع |
|---|---|---|
| Hocuspocus (`@hocuspocus/server`) | 4.9.0 (2026-11-20) | npm `[source]` |
| Tiptap Hocuspocus scalability | تقسیم سند بین instanceها؛ Redis extension؛ حد سند ذکر نشده | tiptap.dev `[source]` |
| Yjs 14 "who is using Yjs" | لیست پروژه‌ها در README rc.30 (Onplana، Doory، Breatic، Oxynote، Folio) | GitHub `[source]` |
| AFFiNE | استفاده از Yjs؛ جزئیات مقیاس **تأیید نشد** | — |
| حد سند | هیچ حد رسمی در Yjs/Hocuspocus پیدا نکردم؛ انجمن: مشکل load برای ~16 MB؛ محدودیت ۱۶ MB سند MongoDB | `[secondary]` discuss.yjs.dev |

- `[secondary]` انجمن Yjs: با ویرایش عادی تایپ شدن، رسیدن به ۲ MB «تقریباً غیرممکن» است، ولی هر mousemove یک update، سند را بزرگ می‌کند.
- `[inference]` برای Nevis، سقف‌های حافظه‌ی سرور برای relay بایتی کم‌هزینه‌اند؛ هزینه‌ی واقعی در کلاینت (load و undo) است.

## ۶. Persian / RTL / IME

- `[source]` جستجو در issueهای `yjs/y-prosemirror` و `ueberdosis/tiptap` برای کلیدواژه‌های `rtl`، `bidi`، `dir` و IME، هیچ issue مختص فارسی/RTL در binding پیدا نکرد.
- `[source]` tiptap #7899 (باز، 2026-05-30): جلوگیری از پرش cursor در IME با متن رنگی.
- `[source]` tiptap #8626 (IME + Backspace) و #8617 (selection بعد از remote edit، باز).
- `[secondary]` discuss.prosemirror: IME با prediction، Android/iOS، و `compositionend` بعد از prosemirror-view 1.33.3 (ثبت‌شده در انجمن ProseMirror؛ وضعیت فعلی را تأیید نکردم).
- `[inference]` چون هیچ گزارش RTL یا فارسی پیدا نشد، این به معنای نبود مشکل نیست؛ تست دستی با کیبورد فارسی روی macOS، Windows (WebView2) و WebKit باید انجام شود.

## ندانسته‌ها

- فرمت wire و breaking changeهای دقیق Yjs 14 rc.30 را نخواندم؛ release notes رسمی rc را پیدا نکردم.
- ضمانت سازگاری بایتی yrs و yjs را پیدا نکردم؛ بدنه‌ی `y-crdt#632` را نخواندم.
- اعداد رشد سند بعد از N ویرایش را از منبع اولیه پیدا نکردم؛ ارقام #8632 (~۳۰ MB بعد از ۳۰ undo روی ۱۰۰ پاراگراف) تنها مثال خوانده‌شده است.
- رفتار `null` attrs در y-prosemirror و tombstone retention را از کد منبع تأیید نکردم.
- `loro-prosemirror` و `@automerge/prosemirror` نسخه‌های npm اخیر و تاریخ ریلیز را مطمئن نشدم.
- AFFiNE و سایر محصولات تولیدی: جزئیات مقیاس و مشکلات گزارش‌شده را پیدا نکردم.
- ADR قبلی (`docs/adr/0001-editor-choice.md`) در repo قدیمی است و تست IME واقعی را نکرده است؛ من هیچ تست IME یا bidi را اجرا نکردم.
- ۲۰۲۶ issueهای `y-tiptap` مثل #8632 و #8715 در زمان تحقیق باز بودند؛ ممکن است قبل از تصمیم تعمیر شوند.
