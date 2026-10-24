# 01 — تعریف مسئله و MVP (v0.1)

> وضعیت: پیش‌نویس. بخش «تصمیم‌ها» قطعی است؛ بقیه پیشنهاد است.

## مسئله
یک برنامه دسکتاپ آفلاین برای نوت‌برداری درسی و فنی (جاوا، ریاضی و مشابه)، با ادیتوری که متن فارسی، انگلیسی و ترکیبی را مثل Word درست مدیریت کند: جهت متن به‌هم نریزد، جدول خراب نشود، paste از Word/وب/چت‌های AI درست باشد.

## تصمیم‌ها (قطعی)
- Local-first؛ SQLite (WAL) منبع حقیقت.
- فارسی/RTL ستون هویتی محصول است.
- Windows اول، بعد macOS؛ موبایل بعداً.
- Sync اختیاری و جدا از Backup؛ فعلاً خارج از MVP.
- Java فعلاً کنار گذاشته شده؛ Core با Tauri 2 + Rust + TypeScript/React (پیشنهاد، منتظر spike).
- ادیتور و RTL بالاترین اولویت‌اند.

## معیار پذیرش RTL/bidi (مثل Word)
1. جهت هر پاراگراف مستقل است؛ تشخیص خودکار از اولین حرف قوی + تغییر دستی (Ctrl+Shift+Right/Left).
2. متن ترکیبی داخل یک خط (فارسی + `count` + عدد) بدون جابه‌جایی نشانه‌گذاری.
3. لیست‌ها: bullet/شماره سمت درست، تورفتگی معکوس در RTL.
4. جدول: جهت کل جدول و هر سلول قابل تنظیم؛ افزودن/حذف سطر و ستون، ادغام سلول، paste از Word/وب.
5. Code block و فرمول همیشه LTR، حتی داخل صفحه فارسی.
6. نیم‌فاصله (ZWNJ)، ارقام فارسی/انگلیسی، علائم نگارشی، IME و جابه‌جایی کیبورد.
7. فونت پیش‌فرض خوانا (Vazirmatn) با fallback.
8. Paste با حفظ ساختار (heading، list، جدول، کد) از Word، وب و چت‌های AI.

## MVP
**Must:** ادیتور بلاکی با `/`، heading/list/checklist/quote/callout/toggle، جدول کامل، code block با highlight، تصویر، صفحه و زیرصفحه، sidebar، auto-save مقاوم، search فارسی/انگلیسی، export Markdown، backup/restore.

**Should:** LaTeX، page links/backlinks، import Markdown، templates ساده.

**Later:** دیتابیس و viewها، Sync، موبایل، Relation/Formula، Relay Server.

## ریسک‌های اصلی
1. کیفیت ادیتور (bidi، IME، جدول).
2. گسترش دامنه به سمت «Notion کامل».
3. Data corruption / crash safety.
4. (بعداً) پیچیدگی CRDT + E2EE و recovery key.

## قدم بعدی
Spike ادیتور: TipTap در برابر BlockNote با تست‌های RTL (پوشه `spike/`). خروجی: ADR-0001.
