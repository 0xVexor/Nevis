# وضعیت

آخرین به‌روزرسانی: 2026-11-21، پایان M13.

| بخش | وضعیت | امتحان کنید |
|---|---|---|
| 00 راه‌اندازی ریپو و فرایند | انجام شد | این اسناد |
| 01 تحقیق | انجام شد | `docs/research/R1..R7` |
| 02 تصمیم و برنامه | انجام شد | `docs/DECISIONS.md`، `docs/adr/`، `docs/ROADMAP.md` |
| M1 spike ادیتور | کد و آزمون خودکار سبز (`m1`)؛ چک‌لیست iPhone/Safari با مالک | `docs/reports/03-m1-editor-spike.md`، `docs/checklists/M1.md` |
| M2 هستهٔ لاگ + سرور Go + harness | انجام شد (`m2`) | `docs/reports/04-m2-log-core.md`؛ `corepack pnpm converge` |
| M3 IndexedDB + leader چندتب + crash | خودکار سبز (`m3`)؛ iPhone و آزمون ۷ روزه با مالک | `docs/reports/05-m3-idb-leader-crash.md`، `docs/checklists/M3.md` |
| M4 سرور واقعی + ورود وب | خودکار سبز (`m4`)؛ چک‌لیست iPhone/Safari با مالک | `server/scripts/demo.sh` → http://localhost:8788؛ `docs/reports/06-m4-server.md`، `docs/checklists/M4.md` |
| M5 برش عمودی وب (صفحه + Yjs + سینک) | خودکار سبز (`m5`)؛ Safari/iPhone و IME با مالک | `server/scripts/demo.sh` → http://localhost:8788؛ `docs/reports/07-m5-web-vertical-slice.md`، `docs/checklists/M5.md` |
| M6 دسکتاپ Tauri + SQLite | خودکار سبز روی macOS (`m6`)؛ Windows، keychain واقعی و رابط عادی اپ با مالک | `corepack pnpm --filter @nevis/desktop tauri dev`؛ `docs/reports/08-m6-desktop.md`، `docs/checklists/M6.md` |
| M7 دادهٔ ساختاریافته (پایگاه‌داده، نما، تنظیمات) | خودکار سبز (`m7`)؛ چک‌لیست با مالک | وب: «پایگاه‌داده» در نوار کنار؛ `docs/reports/09-m7-structured-data.md`، `docs/formats/records-v1.md`، `docs/checklists/M7.md` |
| M8a ادیتور کامل (همهٔ بلوک‌ها، `SV = 2`) | خودکار سبز (`m8a`)؛ Safari/iPhone/IME/paste از Word با مالک | «نمونهٔ همهٔ بلوک‌ها» در نوار کنار؛ `docs/reports/10-m8a-editor.md`، `docs/formats/golden-fixtures.md`، `docs/checklists/M8a.md` |
| M8b اپ کامل (طراحی قدیمی، خانه، همهٔ صفحه‌ها، قالب‌ها، تنظیمات، palette، نماهای پایگاه‌داده و برد) | خودکار سبز (`m8b`)؛ «حس اپ قدیمی» و iPhone با مالک | `docs/reports/11-m8b-app.md`، `docs/checklists/M8b.md`؛ `corepack pnpm check` |
| M9 پیوست‌ها و blob (`SV = 3`) | خودکار سبز (`m9`)؛ Safari/iPhone با فایل بزرگ و دمو با مالک؛ **`SV = 3` منتظر تأیید معمار** | `docs/reports/12-m9-attachments.md`، `docs/checklists/M9.md` |
| M10 جست‌وجو و ایندکس‌های مشتق | خودکار سبز (`m10`)؛ بنچ iPhone/Safari با مالک | `docs/reports/13-m10-search.md`، `docs/checklists/M10.md`؛ `corepack pnpm bench:search` |
| M11 فلش‌کارت و تاریخچهٔ صفحه | خودکار سبز (`m11`)؛ چک‌لیست با مالک | `docs/reports/14-m11-cards-history.md`، `docs/checklists/M11.md` |
| M12 export/import، آینهٔ Markdown، import قدیمی | خودکار سبز (`m12`)؛ **import دادهٔ واقعی مالک منتظر شماست** | `docs/reports/15-m12-export-import.md`، `docs/checklists/M12.md`، `docs/formats/bundle-v1.md` |
| M13 snapshot، purge، هرس لاگ، جریان نسخه | خودکار سبز (`m13`)؛ **هرس واقعی ۳۰ روزه و بکاپ را اول روی دادهٔ آزمایشی ببینید**؛ `pg` در envelope منتظر تأیید معمار | `docs/reports/16-m13-snapshot-purge.md`، `docs/checklists/M13.md` |
| M14 … M16 | در انتظار | `docs/ROADMAP.md` |
| **مرحلهٔ ظاهر (پیشنهادی، بعد از M10)** | **منتظر شروع** | مقایسهٔ کنار‌به‌کنار با اپ قدیمی و رفع تفاوت‌ها (آیکن/کاور صفحه، برچسب، نوار کنار، خانه) |

## ظاهر: آنچه با اپ قدیمی یکی است و آنچه نیست
**کپی عینی (شیوه‌نامه‌ها، markup و کلاس‌های قدیمی):** شیوه‌نامهٔ کامل (`ds/areas`، ۳۱ فایل) · ریل آیکن‌ها، پنل صفحه‌ها با درخت (`PageTree` کپی‌شده)، نوار بالا و breadcrumb · خانه (`HomeScreen` کپی‌شده + یادداشت سریع) · سطل · فلش‌کارت (markup قدیمی، منطق جدید) · دیالوگ تاریخچه · قاب ورود/فهرست workspace/آدرس سرور با `onb-*` (**قدیمی، حساب نداشت**: طراحی با همان قاب و کامپوننت‌ها، نه کپی).
**هنوز اپ قدیمی نیست (کار ظاهر بعدی):** «همهٔ صفحه‌ها» (`PagesTable` پیاده نشد) · گراف (`GraphView` قدیمی نه؛ نسخهٔ ساده ما) · کارها (`Tasks.tsx` قدیمی نه) · قالب‌ها (`TemplateGallery` نه) · تنظیمات (`SettingsPage` با تب‌ها نه؛ گروه‌بندی ساده با اجزای قدیمی) · نمای پایگاه‌داده و برد (اجزای خودمان با کلاس‌های ds) · صفحه: آیکن، کاور، وضعیت، برچسب، outline و `pg-links` برای پیوندهای ورودی · نوار ابزار شناور/منوی «اشتراک» · جست‌وجوی داخل صفحه (`pg-find`) · حالت خواندن · فلش‌کارت بدون کلیدهای میانبر قدیمی و رندر غنی پاسخ.
**مقایسهٔ کنار‌به‌کنار عکس‌به‌عکس برای هر صفحه انجام نشده** (فقط خانه و پوسته با نگاه چشمی در این جلسه)؛ تا آن مقایسه، ادعای «مو به مو» نمی‌شود.

## کار مالک الان
- چک‌لیست‌های `docs/checklists/M1.md`، `M3.md`، `M4.md`، `M5.md`، `M6.md`، `M7.md`، `M8a.md`، `M8b.md`، `M9.md`، `M10.md` روی Safari macOS و iPhone (HTTPS: `docs/dev-https.md`).
- `docs/OPEN-QUESTIONS.md` (به‌ویژه ۱: سینک پس‌زمینه، ۲: E2EE، ۸: نام پیش از M6).
- معمار: اصلاح ADR-0003 بند ۱۳ (سقف hold ۱۰ ثانیه) و ADR-0001 بند ۶ (`persist()` نباید await شود).

## باگ‌های باز
- paste چندبلوکی در مکان تصادفی: در آزمون فشار ۰٪ (بدون undo) و ۱٫۳٪ (با undo) ناهماهنگی view/Y.Doc؛ علت ریشه‌ای بررسی نشده (`docs/reports/10-m8a-editor.md`).
- Safari واقعی با فایل بزرگ در IndexedDB سنجیده نشده (M9 چک‌لیست ۴)؛ WebKit بدون Blob در IDB به ArrayBuffer برمی‌گردد.
- paste در Firefox و درگ HTML5 در WebKit/Firefox را آزمون خودکار نمی‌تواند بسنجد (چک‌لیست M8a).

## منبع قدیمی (مرجع)
ریپوی قدیمی: `/Users/wrangler/Developer/Projects/Nevis`، شاخهٔ `feature/web`.
