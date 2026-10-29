# اصلاح رابط و تأخیر همگام‌سازی — ۲۰۲۶/۱۰/۲۹

رابط Drive با کارت‌ها، دکمه‌ها، فاصله‌ها و رنگ‌های دیزاین سیستم موجود یکدست شد. تب‌های نمای کلی، فضاهای کاری، تاریخچه، ترجیحات و پیشرفته، عملیات موجود را نگه می‌دارند. اطلاعات فنی و تنظیم توسعه‌دهنده در نمای اصلی نمایش داده نمی‌شوند. بیست کنترل سیاست تنظیمات حفظ شده‌اند. وضعیت آفلاین، در انتظار، خارج‌شده و تعارض دیگر به‌اشتباه «به‌روز» نشان داده نمی‌شود. تاریخ نامعتبر نمی‌تواند دیالوگ را خراب کند.

## علت کندی و اصلاح

اندازه‌گیری خواندنی از نسخهٔ قبلی در حساب واقعی: یک دور بدون ارسال ۹۸۵۴ میلی‌ثانیه، ۱۰ درخواست، اولین header برابر ۶۲۱۷ میلی‌ثانیه بود. این فقط یک نمونه است و علت دقیق کندی شبکه را اثبات نمی‌کند.

- تأخیر پس از توقف تایپ: ۴۵ ← ۲ ثانیه؛ سقف هنگام تایپ مداوم: ۳۰۰ ← ۱۰ ثانیه.
- فاصلهٔ حداقلی انتشار خودکار: ۹۰ ← ۲ ثانیه؛ کار معوق پس از دور جاری به‌جای poll عادی، حداکثر پس از انتظار ۲ ثانیه دوباره بررسی می‌شود.
- اتصال HTTP بین دورها استفادهٔ مجدد می‌شود؛ پس از ۵ دقیقه یا شکست ارسال کنار گذاشته می‌شود. تست TCP واقعی استفادهٔ دو handle از همان اتصال را تأیید می‌کند.
- بررسی هویت پوشه‌ها، هش فایل‌ها و backoff اجباری سهمیه حذف نشده‌اند.

این اعداد زمان انتظار برنامه‌اند؛ زمان ذخیره، عملیات جاری، شبکه، آپلود و پاسخ گوگل به آن اضافه می‌شوند. دریافت خودکار تغییرات دستگاه دیگر در حالت بدون فعالیت هنوز poll حدود ۵۵ تا ۶۵ ثانیه‌ای دارد؛ فوکوس/آنلاین‌شدن و دکمهٔ Sync now می‌توانند زودتر بیدار کنند. نخستین آپلود، رسانه و بررسی کامل پوشه‌ها همچنان هزینه دارند. سرعت حساب واقعی با باینری تازه هنوز اندازه‌گیری نشده است؛ تضمین «Sync کامل در دو ثانیه» نداریم.

## اعتبارسنجی

۲۰۸ تست Rust موفق، صفر شکست، ۱۱ ignored موجود؛ ۱۰۲ تست Drive و هیچ ignored در Drive. هر دو fixture بزرگ ۱۲۸MiB و cold restore هزار صفحه نیز در این اجرا موفق بودند. زمان مجموعه ۱۱۰٫۱۹ ثانیه است و معیار سرعت Google نیست.

۲۳۴ تست JavaScript موفق: ۵۰ رابط/کنترلر، ۱۷۳ دیتابیس، ۴ جهت متن و ۷ به‌روزرسانی. Build وب و بستهٔ تنظیم‌شدهٔ Preview مک ARM64 موفق. lint دارای ۲۳۷ warning و صفر error است؛ هشدارهای قبلی باقی‌اند.

بررسی مرورگر با اجزای نمایشی واقعی و دادهٔ نمونه: روشن انگلیسی، تیرهٔ فارسی، فضاهای کاری خالی و فرم ساخت، تاریخچه، ترجیحات و پیشرفته؛ عرض ۳۹۰ بدون overflow افقی محتوا؛ حرکت بین تب‌ها با جهت صفحه‌کلید، یک پنل نمایان، مهار فوکوس، Escape عادی و جلوگیری از Escape هنگام عملیات فعال. این بررسی، آزمون عملی OAuth/restore/conflict روی حساب واقعی نیست. فایل پیش‌نمایش توسعه وارد بستهٔ production نمی‌شود.

بستهٔ کپی‌شده در نخستین بررسی codesign خطای resource seal داشت؛ امضای ad-hoc محلی دوباره اعمال شد و `codesign --verify --deep --strict` موفق شد. این امضای Developer ID یا notarization اپل نیست. برنامهٔ باز کاربر جایگزین یا بسته نشد.

## بررسی دستی نسخهٔ جدید

۱. در برنامهٔ فعلی تا نمایش Saved صبر کنید، سپس آن را ببندید و بستهٔ جداگانهٔ Responsive را باز کنید؛ دو نسخه را روی یک Vault هم‌زمان اجرا نکنید.
۲. یک جملهٔ آزمایشی ویرایش کنید، تایپ را متوقف کنید و زمان رسیدن از «در انتظار» به «به‌روز» را بسنجید. اگر کند بود، از Advanced → Sync diagnostics فقط lastRun شامل elapsedMs، requests، operations و headerLatencyMs را بررسی کنید؛ توکن یا متن یادداشت لازم نیست.
۳. با تایپ پیوسته حدود ۱۵ ثانیه، ارسال دوره‌ای و سپس رسیدن کار معوق به صفر را بررسی کنید. تغییر را با قطع شبکه نگه دارید و پس از وصل‌شدن، سالم‌ماندن متن و ارسال را بررسی کنید.
۴. در فارسی/انگلیسی و روشن/تیره تب‌ها را باز کنید، ساخت/یافتن/بازکردن فضای کاری آزمایشی را بررسی کنید. Restore را فقط به کپی جدید آزمایشی اجرا کنید.
۵. دریافت روی دستگاه دوم، refresh طولانی‌مدت حساب، Windows و انتشار signed/notarized هنوز تأیید نشده‌اند. releaseReady همچنان false است.

## Upload transfer follow-up and latest-dev integration

The user clarified that transfer time itself was slow. Objects up to 4MiB now use multipart with their durable reserved ID instead of starting a resumable session. A newly created object through object_file takes 6 requests instead of 8 on the successful path. Fresh large-file sessions send bytes immediately; recovered sessions still probe Google's acknowledged offset. Remote byte/hash verification remains mandatory. Real HTTP fixtures verify small-file unknown-response recovery and fresh-session direct upload. These are request savings, not a measured increase in the user's Internet bandwidth.

Diagnostics now record wallElapsedMs for actual cycle duration and operationElapsedMs for header-wait totals by operation. Existing elapsedMs remains compatible. New-binary Google transfer latency has not been measured.

The toolbar icon turns green only with idle state, signed-in account, sync enabled, positive successful timestamp and no error/reason. Pending, paused, offline and conflicts cannot inherit green from an older success. The dialog uses the same --ok success token.

Preference controls now use the existing shared Select instead of native OS select menus. Arrow/Home/End navigation and Escape closing the menu without closing the dialog were verified. The successful status computes to the green --ok color. Open-menu screenshot: artifacts/drive-ui/preferences-menu-en.png.

Merged origin/dev 5bee6a6. Every dev translation retains its exact value; configureBackupFolder retains dev's name. dragHandle/layout/snapModel/layout CSS match dev exactly; Drive StableBlockIds and editor conflict archival remain integrated. Post-merge validation: 210 Rust PASS (104 Drive), zero failed, 11 existing ignored; 236 app JS PASS (52 layout/controller, 173 database, 4 direction, 7 updater); 64 server PASS; 10 local legacy-sync e2e PASS; 2 desktop-build script PASS; 4 installer script PASS. TypeScript/Vite PASS; lint 237 existing warnings, zero errors. The initial server invocation could not load fastify because dependencies were absent; npm ci resolved it and all 64 tests then passed. Local legacy-sync e2e does not certify two-device Google Drive behavior.


Initial PR CI on macOS and Linux found a pre-existing timing assumption in sync_trash_keeps_files_and_purges_old_ones: two different relative file paths can share a millisecond trash directory, so counting exactly two directories is invalid. The regression now asserts byte-for-byte retention of both the page and settings, while still requiring old trash to be removed. Production trash behavior is unchanged. Both first CI results were 209 PASS / 1 FAIL / 11 ignored; final CI must pass on the corrected head before merge.


All five jobs passed on d5fdb03, but dev correctly blocked merge because its required checks are server, app and end-to-end. Expanding app into a platform matrix had replaced the exact app check name. The workflow now retains the three platform checks and adds the required app aggregate gate, using always() and a strict success test of the matrix result. Any failed/cancelled platform fails the aggregate. Branch protection is unchanged. Final merge requires the new head's checks, including app, to succeed.
