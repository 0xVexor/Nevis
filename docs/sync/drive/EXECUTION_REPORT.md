# گزارش اجرای Nevis Google Drive Sync — ۲۰۲۶/۱۰/۲۹

## نتیجهٔ واقعی

**کد واقعی و اتصال برنامه پیاده‌سازی شده، اما این خروجی هنوز آمادهٔ انتشار و معادل عبور کامل سند نیست.** Drive به‌صورت پیش‌فرض خاموش و `releaseReady=false` است. نبود OAuth تنها محدودیت باقی‌مانده نیست؛ موارد داخلی و آزمون‌نشده در بخش محدودیت‌ها مشخص‌اند.

- برنچ: `feature/drive-sync`، بدون نام codex.
- worktree: `/Users/wrangler/.codex/worktrees/google-drive-sync/Nevis`.
- مبنا: شاخهٔ GitHub Sync در e061895 و آخرین dev دریافت‌شده در 45069f2؛ ادغام e140ce7. دریافت دوبارهٔ dev نیز همان commit را تأیید کرد.
- تغییرات هم‌زمان checkout اصلی کاربر حفظ شده‌اند. به dev یا سرویس انتشار push نشده است.
- متن کامل پلن در EXECUTION_PLAN_FA.md نگه داشته شده؛ ماتریس تمام ۱۰۴ معیار از نتیجهٔ تست‌های مشاهده‌شده محاسبه می‌شود.

## تغییرات پیاده‌سازی

| بخش | تغییر و اثر |
|---|---|
| دامنهٔ مستقل Drive | batchهای immutable، sequence/frontier/previous hash، نبود shared HEAD، patch با preimage، تمایز null/absence، انتقال JSON بزرگ به object و atomic group برای capture چندبخشی |
| ذخیره و بازیابی | journal/outbox/inbox پایدار، رزرو ID پیش از انتشار، retry با همان ID بعد از پاسخ نامطمئن، انتشار multipart markerهای کوچک، ثبت discovery پیش از cursor، بازیابی apply و حفظ نسخهٔ سوم محلی |
| OAuth و انتقال | Desktop PKCE، مرورگر سیستم، callback/state محدود و اعتبارسنجی‌شده، لغو generation، refresh سریالی، OS credential store بدون فایل توکن، خطاهای پاک‌سازی‌شده، Retry-After و chunk/session receipt |
| رسانه | capture/download/apply فایل‌محور، کپی و hash با buffer 64KiB، chunkهای 8MiB، فایل موقت تأییدشده پیش از rename؛ مسیر source از receipt/network deserialize نمی‌شود |
| ادغام صفحه | رجیستری سراسری بلاک‌ها در هر صفحه، جداسازی parent از محتوا، move+edit، insert هم‌زمان، بازیابی ancestor حذف‌شده و archive ساختاری، حفظ opaque JSON |
| تعارض | base/A/B کامل، provenance برای جلوگیری از یکی‌شدن تعارض تکرارشده، تصمیم causal حتی برای انتخاب بدون تغییر؛ Keep both با page/block ID تازه برای صفحهٔ معمولی؛ ردیف دیتابیس clone نمی‌شود |
| دیتابیس | حفظ ۱۳ نوع رکورد، کنترل referenceهای شناخته‌شده، source سلول/رابطه و collision تخصیص ID؛ مهاجرت sequential به partitioned با حفظ ID/token موجود و receipt قابل‌ادامه؛ حذف/ویرایش متعارض رکورد و collision ایجاد مستقل archive می‌شوند |
| تنظیمات | policy نسخه‌دار global/device-local برای ۲۰ کلید؛ مقادیر محلی پیش از batch/preimage/checkpoint حذف می‌شوند و مقدار این نصب هنگام دریافت حفظ می‌شود |
| قفل و سازگاری | قفل OS در تمام عمر Vault، اشتراک handle داخل process، رد process دوم، شناسهٔ منطقی ثابت، رد تعویض marker/lock و fence فرمت ۲ برای client قدیمی |
| هویت remote | descriptorهای مستقل immutable برای root/Vault، metadata و owner/ID معتبر، setup receipt؛ duplicate root یا descriptor ناسازگار انتخاب تصادفی نمی‌شود |
| اتصال و دریافت | بکاپ قبل از مهاجرت، آماده‌سازی خارجی قبل از fence، provider-switch receipt؛ staging با مالکیت/token و ادامهٔ دانلود قطع‌شده، بدون جایگزینی مقصد نامرتبط |
| checkpoint/history | انتشار manifest-last پس از بازسازی مستقل، inventory/frontier/heads/coverage ledger/provenance/tombstones و dependencyهای تاریخچه؛ bootstrap از seed غالب + tail؛ restore به کپی محلی با UUID تازه |
| GC | dry-run/verify/proof پایدار، رد proof قدیمی، guarded execute/recovery با receipt؛ حذف واقعی عمداً در این build در دسترس نیست |
| زمان‌بندی و UI | سکون ۴۵ ثانیه، حداکثر ۵ دقیقه، فاصلهٔ خودکار ۹۰ ثانیه، دریافت هنگام throttle، poll با jitter، focus/online/background و ذخیره پیش از close؛ pause قبل از mutex علامت می‌خورد و درخواست بعدی را متوقف می‌کند |
| عیب‌یابی | شمارش روزانهٔ HTTP به‌ازای حساب روی این نصب، عملیات/بایت/rate limit، پنجرهٔ محدود p50/p95 زمان دریافت header، هشدار بودجهٔ نرم، deep check محلی، رابط فارسی/RTL |

ورود به editor اکنون نوع Vault را از marker محلی می‌خواند و تخصیص block ID را پیش از اولین render فعال می‌کند؛ به OAuth یا poll دوثانیه‌ای وابسته نیست. پس از connect، دادهٔ مهاجرت‌یافته دوباره وارد store می‌شود.

## نتایج آزمون نهاییِ ادامهٔ کار

- مجموعهٔ کامل Rust روی کد اصلاح‌شده: **۱۹۸ موفق، صفر ناموفق، ۱۱ ignored**، زمان 132.65 ثانیه. تست تازهٔ backoff پایدار سپس با ۴ تست زمان‌بندی موجود اجرا شد: **۵ موفق**. با احتساب regression تازهٔ ورود مستقیم Secret، نتیجهٔ یکتای logهای نهایی **۲۰۰ موفق، صفر ناموفق، ۱۱ ignored** است؛ **۹۵ تست Drive**. تست‌های root پس از سخت‌گیری نام نمایشی نیز ۳/۳ موفق بودند.
- JavaScript: layout/editor/policy **43**، دیتابیس **173**، جهت متن **4**، به‌روزرسانی **7**؛ مجموع **۲۲۷ موفق، صفر ناموفق**.
- TypeScript/Vite و lint موفق؛ lint **۲۳۶ warning و صفر error** دارد.
- Preview debug مک ARM64 با Client ID عمومی واقعی ساخته شد. بستهٔ مستقل `com.vexor.nevis.drive-preview` همچنان release امضاشده/notarized نیست.
- ماتریس ۱۰۴ مورد: **۴۶ PASS مصنوعی، صفر FAIL در تست‌های نگاشت‌شده، ۵۸ NOT_RUN**. NOT_RUN شامل محدودیت‌های داخلی و آزمون‌های خارجی است؛ به معنای عبور کامل پلن نیست.
- Smoke رابط نسخهٔ اصلاح OAuth: باز شدن برنامه، ورود از صفحهٔ شروع به Google Drive Sync، و وجود Import Desktop OAuth JSON و Sign in with Google مشاهده شد. این نتیجه، ورود واقعی یا گردش تعارض متصل را تأیید نمی‌کند.
- **ورود واقعی در Preview قبلی ناموفق بود.** گوگل برای Client ID واقعی در یک probe بدون authorization code معتبر، `invalid_request: client_secret is missing` برگرداند. PKCE به‌تنهایی برای این کلاینت کافی نبود. نسخهٔ اصلاح‌شده JSON کلاینت Desktop را با کنترل Client ID وارد Keychain می‌کند و هنگام code exchange و refresh می‌فرستد. ورود/refresh واقعی نسخهٔ اصلاح‌شده هنوز منتظر تست کاربر است؛ شکست قبلی پنهان یا PASS نشده است.

## اصلاحات این ادامه

- Rootهای هم‌نام با ID/marker معتبر در UI فهرست می‌شوند؛ انتخاب صریح، نمایش پوشه، جداسازی حساب و جلوگیری از انتقال خاموش bindingهای موجود اضافه شد. Find اکنون read-only است و root جایگزین برای root مفقود نمی‌سازد.
- History پیش‌نمایش شمارش/عنوان نمونه دارد و صحت کامل را ادعا نمی‌کند. restore به کپی، UUID و نام محلی تازه دارد و هویت و دادهٔ نسخهٔ اصلی را حفظ می‌کند.
- کنترل relation cardinality، edge تکراری، ارجاع view/filter/sort/property، نوع سلول، principal و چرخهٔ parentها اضافه شد. تعارض لینکِ تک‌مقصدی مسیر انتخاب → preview با digest → تصمیم causal دارد؛ نامزدهای بازنده soft-delete می‌شوند و اصل رکورد حفظ می‌شود. fixture واقعی دو دستگاه تا همگرایی و انتشار تصمیم پاس شد.
- Retry-After به صورت delta و HTTP-date، overflow، فایل وضعیت ناخوانا/خراب و منع bypass بررسی شد. backoff سهمیه با تکرار خطا از ۶۰ ثانیه تا ۱ ساعت افزایش و پس از موفقیت reset می‌شود؛ مهلت طولانی‌تر سرور حفظ می‌شود.
- بازپخش از checkpoint برای actor قدیمی که قبل از actorهای پوشش‌داده‌شده مرتب می‌شود، دیگر فقط روی state تا‌شده merge نمی‌کند: آرشیو gzip قطعیِ batch/preimageها با hash در checkpoint نگهداری و صحت کامل آن بررسی می‌شود. سه نامزد هم‌زمان و حذف covered streams تست شد. آرشیوِ بازشده سقف 95MiB دارد؛ checkpoint قدیمی بدون replay archive برای bootstrap انتخاب نمی‌شود و history خام/خطای صریح لازم است. این کار ورودی صحیح ادغام را حفظ می‌کند، ولی هزینهٔ کامل replay را حذف نمی‌کند.
- ارجاع دیرهنگام به پیوست حذف‌شده، bytes و metadata تاریخی را از ورودی‌های تأییدشده بازمی‌گرداند؛ MIME یا size ساختگی تولید نمی‌شود. fixture GIF پس از checkpoint/pruning موفق شد.
- شکل‌های رزروشدهٔ opaque JSON از marker واقعی blob تفکیک شدند؛ کلید سفارشی دیگر ID رکورد را نمی‌پوشاند یا JSON را به‌عنوان فایل باینری اعمال نمی‌کند. ناسازگاری path/hash/blob رد می‌شود.
- Client ID عمومی تولید در build config عمومی است؛ secret ارسالی در چت در فایل/مخزن/log نوشته نشده است. import فایل JSON به صورت محلی و از طریق UI انجام می‌شود. این مرحلهٔ per-device هنوز یک محدودیت محصول/بسته‌بندی برای انتشار عمومی است.

## خطاهایی که پیدا و اصلاح شدند

- null به absence تبدیل می‌شد؛ envelope صریح و regression اضافه شد.
- تعارض‌های تکرارشده با مقادیر یکسان می‌توانستند ID قبلی بگیرند؛ provenance و resolution واقعی در تست اضافه شد.
- child پس از حذف parent یا move متعارض می‌توانست ساختار نامعتبر بسازد؛ ancestor/candidate حفظ و archive می‌شود.
- دستگاه قدیمی checkpoint تازه را از feed نمی‌دید؛ تغییر checkpoint قبل از رسیدگی به removed history خوانده می‌شود.
- بعد از ثابت‌کردن Vault ID، sync قدیمی پوشهٔ بدون marker را تشخیص نمی‌داد؛ preflight هویت/قفل به آن اضافه شد.
- capture فایل‌محور در ابتدا پیش از preflight می‌توانست پوشهٔ ناپدیدشده را دوباره بسازد؛ preflight قبل از هر نوشتن قرار گرفت و تست آن موفق شد.
- apply نیمه‌تمام با JSON فشرده در برابر JSON فرمت‌شده اشتباه «نسخهٔ سوم» می‌داد؛ مقایسهٔ معنایی canonical اصلاح شد.
- دانلود قطع‌شده با journal موجود امکان ادامه نداشت؛ receipt مالکیت staging و کنترل remote خالی در resume اضافه شد.
- آغاز editor می‌توانست پیش از فعال‌شدن block IDs رخ دهد؛ خواندن marker محلی به boot منتقل شد.
- وابستگی تست fake-indexeddb نصب نبود؛ dependency اعلام‌شدهٔ خود پروژه نصب شد. خطای lint مربوط به نام helper قدیمی useFolder هم با تغییر نام محدود اصلاح شد.

## اندازه‌گیری‌ها و حدود آن‌ها

- ۱۰هزار تغییر پیاپی: capture برابر 5487ms، capture+replay برابر 6611ms؛ journal برابر 18,699,610 بایت.
- fixture هزار صفحه، ده‌هزار بلاک و هزار پیوست کوچک: تا پایان publish برابر 77,306ms و تا پایان cold restore برابر 114,720ms؛ ۱۶ batch و 4,335,481 بایت remote مصنوعی.
- اجرای مستقل fixture رسانهٔ 128MiB با `/usr/bin/time -l` روی خود binary تست: **25.66s** و بیشینهٔ RSS **16,039,936 بایت، حدود 15.3MiB**. این fixture از storage دیسکی مصنوعی استفاده می‌کند و hash فایل مقصد را مقایسه می‌کند؛ اندازه‌گیری Google/رابط واقعی یا هزار پیوست بزرگ نیست.
- اجرای اولیهٔ همان fixture پیش از cache هش محلی 158.47s بود؛ نتیجه پنهان نشده است. Debug hashing/copying و journal یکپارچه هنوز هزینه‌برند.

## محدودیت‌ها و gateهای باقی‌مانده

1. ورود واقعی نسخهٔ قبلی به علت client_secret مفقود شکست خورد؛ تست ورود/refresh نسخهٔ اصلاح‌شده، consent و discovery واقعی cross-device هنوز لازم است. از همان publisher project/consent app و client Desktop متناسب با هر پلتفرم استفاده شود. scope برای دورزدن مشکل discovery گسترده نشده است. Windows و release امضاشده در این میزبان در دسترس نیستند.
2. تمام ۱۰۴ سناریو آزموده نشده‌اند: power loss واقعی، ENOSPC/readonly، تمام نقاط crash، ۸ ساعت idle، rate limit طولانی و GUI متصل پوشش کامل ندارند. وجود کد، جای نتیجهٔ آزمون را نمی‌گیرد.
3. رسانه فایل‌محور است، ولی JSON هنوز 95MiB/file و 512MiB aggregate محدودیت دارد؛ marker/checkpoint حداکثر 4MiB است؛ دانلود رسانه 5GiB/object محدود است. آرشیو replay سقف 95MiB بازشده دارد؛ journal/replay همچنان یکپارچه و نگهداری تاریخچه بدون pruning پرهزینه است. نخستین hash/copy ممکن است هنگام نگه‌داشتن mutex بومی زمان ببرد؛ latency واقعی editor باید روی build انتشار اندازه‌گیری شود.
4. cache هش محلی با identity/metadata و حداکثر ۲۴ ساعت اعتبار کار می‌کند؛ تغییر معمول/تعویض اتمیک آن را باطل می‌کند. دست‌کاری محلیِ مخرب که همهٔ metadata را حفظ کند به deep check نیاز دارد. بایت‌های شبکه مستقل hash می‌شوند.
5. کنترل‌های graph دیتابیس و fixtureهای ۱۳ نوع وجود دارند، اما تمام business invariantهای هر نوع و ترکیب‌های چندرکوردی اثبات نشده‌اند. نتیجهٔ نامعتبر به‌صورت fail-closed اعمال نمی‌شود؛ این وضعیت ممکن است به اصلاح/بازیابی صریح نیاز داشته باشد.
6. ترتیب مبهم siblingهای بسیار بزرگ و ساختارهای ناسازگار به archive/fallback محافظه‌کارانه می‌روند. Keep both فقط برای صفحهٔ معمولی است؛ Manual merge با توضیح غیرفعال است. GUI تعارضهای پیچیده روی حساب واقعی بررسی نشده است.
7. انتخاب صریح root معتبر و بررسی/بازکردن آن اضافه شده است؛ Google Picker و repair مجوزی پوشهٔ دلخواه خارج از محدودهٔ drive.file هنوز وجود ندارد. hierarchy فیزیکی streams/objects flat است و با پیشنهاد پوشهٔ per-device/prefix سند تفاوت دارد.
8. GC destructive، حذف retention و quarantine/rollback واقعی به دلیل کامل‌نبودن اثبات‌های release، دستگاه قدیمی و retention فعال نشده‌اند. رشد تعداد Drive items/storage واقعی است. مسیرهای guarded فعلی فقط deferred receipt را بازیابی می‌کنند، نه حذف نیمه‌تمامی که این build هرگز انجام نمی‌دهد.
9. شمارش HTTP و budget نرم معادل quota units یا صورت‌حساب Google نیست؛ OAuth، setup/history/repair دستی و clientهای دیگر در شمارندهٔ worker حساب نشده‌اند. p50/p95 مربوط به header request و پنجرهٔ نمونه است، نه latency کل تجربهٔ کاربر.
10. close، انتشار ابری را تضمین نمی‌کند؛ local save پیش از destroy await می‌شود. درخواست HTTP جاری ممکن است تا timeout طول بکشد. قفل advisory، ابزار خارجیِ بی‌اعتنا به قفل را کنترل نمی‌کند. E2EE و امضای مستقل نویسنده وجود ندارند.

به همین دلیل feature flag و release gate بسته مانده‌اند. این گزارش ادعای «تکمیل کامل سند» یا «آمادهٔ دادهٔ واقعی» ندارد.

## آزمون دستی کاربر و rollback

MANUAL_TEST.md دوازده سناریوی قدم‌به‌قدم دارد: اتصال، انتقال کامل، آفلاین، تعارض، حذف/ویرایش، رسانهٔ قطع‌شده، rename/revoke، history به کپی، pause/reconnect، policy/deep check و ادامهٔ staging. فقط حساب و Vault آزمایشی استفاده شود.

پیش از تغییر provider بکاپ تأییدشده ساخته می‌شود. برگشت به build قدیمی باید با کپی تازه از بکاپ باشد؛ marker فرمت ۲ را دستی ویرایش نکنید. outbox/device ID/receiptها برای عبور از خطا پاک نشوند. پوشه‌های Google/GitHub و دادهٔ اصلی کاربر به‌صورت خودکار حذف نشده‌اند. فهرست دقیق فایل‌ها در CHANGED_FILES.md است.

## اصلاح راهنمای تنظیمات بر اساس تصویر واقعی Console

در صفحهٔ کلاینت کاربر گزینهٔ دانلود Secret موجود دیگر ارائه نمی‌شود؛ راهنمای قبلی دانلود JSON برای آن صفحه اشتباه بود. مسیر «وارد کردن Secret ذخیره‌شده» با فیلد password و ذخیره در Keychain اضافه شد. مقدار پس از شروع ذخیره از فیلد پاک می‌شود و هیچ Secret واقعی در کد، ابزار یا log درج نشده است. ۵ تست OAuth موفق بودند؛ یک تست تازه به مجموع یکتای نهایی اضافه شد: **۲۰۰ Rust موفق، صفر ناموفق، ۱۱ ignored**، شامل **۹۵ تست Drive**. این مجموع حاصل log کامل قبلی و regressionهای تازه است، نه ادعای اجرای دوبارهٔ همهٔ تست‌ها. TypeScript/Vite و lint نیز دوباره موفق بودند. ورود واقعی هنوز منتظر اقدام کاربر است.
