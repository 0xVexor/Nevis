# R5: متن فارسی، جست‌وجو، جهت‌نما و فونت برای Nevis

تاریخ تحقیق: 2026-11-20. برچسب‌ها: [source] = منبع اولیه که صفحه‌اش باز و خوانده شد؛ [secondary] = خلاصه یا نتیجه جست‌وجو، نه متن کامل؛ [inference] = استنباط یا دانش عمومی که در این تحقیق تأیید نشد.

## معنای این برای تصمیم ما

1. ZWNJ (U+200C) در متن فارسی معنادار است و در «می‌خواهم» حذف‌شدنی نیست؛ برای جست‌وجو باید هم با آن و هم بدون آن ایندکس شود. [source: W3C alreq، بخش 4.3.4.1]
2. W3C صریحاً ZWNJ را برای فارسی و نه عربی مشخص کرده است؛ پس قانون نرمال‌سازی باید زبان‌آگاه باشد. [source: alreq، جدول A.5]
3. یای عربی ي (U+064A) و یای فارسی ی (U+06CC) دو کد جدا هستند؛ برای مقایسه و جست‌وجو باید به یک شکل نگاشت شوند. [source: alreq، بخش 5.1]
4. ارقام فارسی (U+06F0–U+06F9) و عربی‌-هندی (U+0660–U+0669) در bidi متفاوت‌اند (EN در برابر AN)؛ این روی نمایش و جهت اعداد اثر دارد. [source: alreq، بخش 6.1.2]
5. اگر SQLite FTS5 با `unicode61` کار کند، ZWNJ به احتمال زیاد جداکننده‌ی کلمه می‌شود و «می‌خواهم» به دو توکن می‌شکند. [inference: صفحه‌ی FTS5 دو بار timeout داد و تأیید نشد]
6. Intl.Segmenter در MDN «Baseline: Widely available» از آوریل 2024 است، ولی رفتار مخصوص فارسی آن تأیید نشد. [source: MDN، دسترسی 2026-11-20]
7. Hazm (Python) نرمال‌ساز، توکنایزر و لماتایزر دارد؛ در مرورگر قابل استفاده نیست مگر پورت شود. [secondary: PyPI و README]
8. فونت Vazirmatn با OFL-1.1 منتشر می‌شود (مجوز بازتوزیع و تعبیه‌ی وب). [source: GitHub]
9. Vazirmatn-FD (ارقام لاتین) در مخزن اصلی پیدا نشد؛ آخرین نسخه‌ی دیده‌شده v33.003 است. [source/absence]
10. Intl.DateTimeFormat با `calendar: "persian"` در MDN آمده است؛ پشتیبانی هر موتور جداگانه تأیید نشد. [source]
11. Intl.Collator('fa') در Firefox ترتیب «و» نسبت به «ه» و «آ» را غلط گزارش کرده؛ وضعیت رفع‌شده نامعلوم است. [secondary: Mozilla support forum]
12. بنچمارک معتبری برای MiniSearch، FlexSearch و Orama روی 10k سند پیدا نشد؛ باید خودمان اندازه‌گیری کنیم. [unverified]

---

## 1. نرمال‌سازی فارسی برای جست‌وجو و مقایسه

| کاراکتر | کد (Unicode) | نام | نکته |
|---|---|---|---|
| ي | U+064A | ARABIC LETTER YEH | یای عربی؛ به ی نگاشت شود [source: alreq] |
| ی | U+06CC | ARABIC LETTER FARSI YEH | مبنای نگهداری |
| ى | U+0649 | ARABIC LETTER ALEF MAKSURA | در فارسی کم‌کاربرد؛ [inference] به ی یا نگه داشته شود، باید تست شود |
| ك | U+0643 | ARABIC LETTER KAF | به ک نگاشت شود [inference: الگوی alreq، جدول A.1 مطابق با نقل شده] |
| ک | U+06A9 | ARABIC LETTER KEHEH | مبنای نگهداری [source: جدول A.1] |
| ۰–۹ | U+06F0–U+06F9 | EXTENDED ARABIC-INDIC DIGITS | ارقام فارسی؛ به 0–9 نگاشت شود [source: alreq 6.1.2] |
| ٠–٩ | U+0660–U+0669 | ARABIC-INDIC DIGITS | ارقام عربی؛ به 0–9 نگاشت شود [source: alreq 6.1.2] |
| ‌ | U+200C | ZWNJ | در ایندکس دو نسخه؛ یکی با حذف، یکی بدون حذف [inference] |
| ـ | U+0640 | TATWEEL (کشیده) | حذف فقط در ایندکس [inference] |
| ً–ْ | U+064B–U+0652 | harakat | حذف فقط در ایندکس [inference] |
| ء/آ/أ/إ/ا | U+0621, U+0622, U+0623, U+0625, U+0627 | hamza و alef | به ا نگاشت شود؛ آ را نگه داشتن هم قابل بحث است [inference] |
| ، | U+060C | ARABIC COMMA | به , یا ، هر دو در جست‌وجو [inference] |
| ؛ | U+061B | ARABIC SEMICOLON | به ; [inference] |
| ؟ | U+061F | ARABIC QUESTION MARK | به ? [inference] |
| « » | U+00AB, U+00BB | guillemets | حذف در ایندکس [inference] |

**نکته‌های NFC و NFKC:** ZWNJ کاراکتر قالب‌بندی (Cf) است و NFC و NFKC آن را حذف نمی‌کنند؛ پس نرمال‌سازی Unicode برای ما کافی نیست. [inference: دانش عمومی Unicode، تأیید نشد] NFKC ارقام عربی و فارسی را به ASCII نمی‌برد و ي/ی و ك/ک را هم یکی نمی‌کند. [inference: همین دلیل]

**قاعده پیشنهادی:**
- متن ذخیره‌شده (DB و فایل) را دست نزنید؛ نرمال‌سازی فقط برای ایندکس و کوئری.
- ZWNJ را در هر دو ایندکس نگه دارید: یک سطر با ZWNJ و یک سطر با حذف آن، و کوئری را هم به دو شکل بزنید. [inference]
- ترتیب: NFC، سپس نگاشت حروف، سپس حذف ZWNJ/تطویل/حرکات، سپس lowercase، سپس ارقام.

## 2. توکنایز و تقسیم کلمه

| موضوع | وضعیت | برچسب |
|---|---|---|
| Intl.Segmenter در MDN «Baseline: Widely available» از آوریل 2024 | تأیید شد | [source: MDN] |
| ورود Firefox به Intl.Segmenter در نسخه 125 | از دانش عمومی | [inference] |
| رفتار Intl.Segmenter('fa', word) با ZWNJ | تأیید نشد | [unverified] |
| Hazm: Normalizer، Stemmer، Lemmatizer؛ لماتایزر 89.9% | گزارش README | [secondary: pypi.org/project/hazm، github.com/roshan-research/hazm] |
| Parsivar و persian-stemmer (JS) | جست‌وجو نشد | [unverified] |

**تحلیل:** ارزش stemming برای Nevis در مرحله‌ی بعد است؛ اول نرمال‌سازی و ایندکس ساده. stemming فقط وقتی لازم است که کاربر بخواهد صرف‌های مختلف یک فعل پیدا شوند. Hazm فقط پایتون است، پس در مرورگر یا WebView باید پورت شود یا سرویس جداگانه بماند. [inference]

**Stop words:** فهرست فارسی معتبر در این تحقیق پیدا نشد؛ Hazm فهرست دارد ولی بررسی نشد. [unverified]

## 3. موتورهای جست‌وجوی کلاینت برای 10k+ سند

| موتور | فارسی | یادداشت | برچسب |
|---|---|---|---|
| SQLite FTS5 unicode61 | ZWNJ احتمالاً جداکننده | نیاز به تست | [inference] |
| FTS5 trigram | پشتیبانی تطابق زیررشته | افزودن remove_diacritics در check-in؛ نسخه‌ی معرفی شده: [inference] 3.34 | [secondary: sqlite.org check-in 0d50172477] |
| MiniSearch | README و پوشه benchmarks | اندازه بسته ~5.9 kB گزارش شده | [secondary] |
| FlexSearch | جدول benchmark در README | ستون‌ها روشن نیست | [secondary] |
| Orama | در جدول FlexSearch | حجم بسته ~22 KB گزارش شده | [secondary] |
| Fuse.js | برای fuzzy | جست‌وجو نشد | [unverified] |

**بنچمارک:** هیچ عدد معتبری برای 10k سند فارسی پیدا نشد. [unverified] باید روی کپی واقعی Nevis بسازیم: زمان ساخت، حجم سریال، حافظه و زمان کوئری در Worker.

**FTS5 در WASM:** امکان tokenizer سفارشی در WASM بررسی نشد. [unverified]

## 4. جهت‌نما و ویرایش RTL

| موضوع | یافته | برچسب |
|---|---|---|
| W3C alreq DNOTE 2025-10-02 | کاراکتر و نمایش؛ جهت‌نما در بخش 3.1 | [source] |
| کمبود بحث جهت‌نما در ProseMirror | گزارش مشخص پیدا نشد | [unverified] |
| WebKit bug 37884 و 49107 | کاربرد جهت یک عنصر در متن مخلوط | [secondary: عنوان‌ها، نه متن] |
| Mozilla bug 300004 | حروف LTR در لبه‌ی RTL | [secondary] |
| Chromium intent به visual-order caret | در حال نمونه‌سازی | [secondary] |
| Android IME و cursorWrapper در ProseMirror | خطای حذف یا جابه‌جایی کرسر | [secondary: discuss.prosemirror.net] |

**dir="auto" در برابر dir صریح:** در کد Nevis از `dir="auto"` روی عنوان‌ها و `dir={dirOf(p.title)}` روی ردیف‌ها استفاده شده [source: کد old repo، App.tsx خط 1320 و 1324]. با dir="auto" جهت بر اساس اولین حرف قوی تعیین می‌شود؛ برای بلوک‌های مخلوط، `unicode-bidi: plaintext` یک گزینه است. [inference: دانش CSS، تأیید نشد]

## 5. فونت‌ها

| فونت | مجوز | نسخه‌ی متغیر | برچسب |
|---|---|---|---|
| Vazirmatn | OFL-1.1 | بله، فایل‌های variable در مخزن؛ تعداد اسنپشات کامل تأیید نشد | [source: github.com/rastikerdar/vazirmatn] |
| Vazirmatn-FD (ارقام لاتین) | یافت نشد | - | [unverified] |
| Sahel، Estedad، Shabnam، Samim، Noto Naskh/Nastaliq | بررسی نشد | - | [unverified] |

**stack پیشنهادی:** `font-family: Vazirmatn, Tahoma, sans-serif` [inference]؛ اگر ارقام لاتین خواسته باشیم، `font-feature-settings` امکان ویژگی‌های ارقام دارد، ولی Vazirmatn را برای ارقام لاتین باید تست کنیم. [unverified]

## 6. تاریخ شمسی

| موضوع | یافته | برچسب |
|---|---|---|
| `Intl.DateTimeFormat` با `calendar: "persian"` | در MDN آمده | [source: MDN] |
| Baseline این API | از سپتامبر 2017 | [source: MDN] |
| پشتیبانی تقویم فارسی در هر موتور | تأیید نشد | [unverified] |
| jalaali-js، date-fns-jalali، Temporal | بررسی نشد | [unverified] |

## 7. مرتب‌سازی فارسی

| موضوع | یافته | برچسب |
|---|---|---|
| Intl.Collator پایه | Baseline، از سپتامبر 2017 | [source: MDN] |
| خطای ترتیب در Firefox با fa | گزارش کاربر؛ رفع نشده یا نامعلوم | [secondary: support.mozilla.org] |
| fallback به locale پیش‌فرض | اگر fa پشتیبانی نشود | [source: MDN] |

**پیشنهاد آزمون:** `new Intl.Collator("fa").resolvedOptions().locale` را در هر مرورگر بسنجید و حروف «و»، «ه»، «آ» را مرتب کنید. [inference]

---

## ندانسته‌ها

- صفحه‌ی FTS5 (sqlite.org/fts5.html و www.sqlite.org/fts5.html) دو بار timeout داد؛ رفتار unicode61 با ZWNJ و تاریخ معرفی trigram تأیید نشد.
- صفحه‌ی alreq در همه‌ی بخش‌ها خوانده نشد؛ 38 هزار کاراکتر آخر نرسید.
- کد normalizeFa در `Nevis/.claude/worktrees/web/spike/tiptap/src` وجود دارد (import شده در meta.ts و App.tsx) ولی فایل normalize.ts و searchIndex.ts باز و بررسی نشد.
- منابع ProseMirror و Chrome Android فقط عنوان‌ها دیده شدند، نه متن.
- Intl.Segmenter برای `fa` تست نشد.
- هیچ بنچمارک 10k سند پیدا نشد.
- Parsivar، persian-stemmer، stop words فارسی و jalaali-js جست‌وجو نشد.
- آخرین release واقعی Vazirmatn (سال انتشار v33.003) تأیید نشد؛ صفحه‌ی releases سال را نشان نداد.
- Sahel، Estedad، Shabnam، Samim، Noto Naskh/Nastaliq بررسی نشد.
- مجوز و وضعیت پشتیبانی همه‌ی تقویم‌ها در مرورگرها تأیید نشد.

## منابع (با تاریخ دسترسی 2026-11-20)

- W3C Arabic & Persian Layout Requirements, DNOTE 2025-10-02: https://www.w3.org/TR/alreq/
- MDN Intl.Segmenter: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
- MDN Intl.DateTimeFormat: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
- Vazirmatn: https://github.com/rastikerdar/vazirmatn
- Hazm: https://github.com/roshan-research/hazm و https://pypi.org/project/hazm
- SQLite FTS5 check-in: https://sqlite.org/cgi/src/info/0d50172477064dce (secondary)
- Mozilla support thread (Collator fa): https://support.mozilla.org/et/questions/1046789 (secondary)
- ProseMirror Android IME: https://discuss.prosemirror.net/t/contenteditable-on-android-is-the-absolute-worst/3810 (secondary)
- MiniSearch: https://npmjs.com/package/minisearch (secondary)
