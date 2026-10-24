<div align="center" dir="rtl">

<img src="spike/tiptap/src-tauri/icons/128x128.png" alt="Noviq" width="96" height="96">

# Noviq.

**فضای کار یادداشت‌برداری آفلاین با پشتیبانی کامل از فارسی و راست‌به‌چپ.**

ادیتور بلاکی · بک‌لینک و گراف · فلش‌کارت با تکرار فاصله‌دار · سینک اختیاری با Google Drive · بدون سرور، بدون حساب کاربری.

[![Build installers](https://github.com/AliMirzad/noviq/actions/workflows/release.yml/badge.svg)](https://github.com/AliMirzad/noviq/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/AliMirzad/noviq?include_prereleases&label=release)](https://github.com/AliMirzad/noviq/releases)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-6c72ff)

[دانلود](https://github.com/AliMirzad/noviq/releases) · [وب‌سایت](https://alimirzad.github.io/noviq/) · [حریم خصوصی](https://alimirzad.github.io/noviq/privacy.html) · [English](README.md)

<br>

<img src="docs/screenshots/editor.png" alt="ادیتور Noviq با یک یادداشت فارسی" width="100%">

</div>

<div dir="rtl">

---

## چرا Noviq

بیشتر برنامه‌های یادداشت‌برداری راست‌به‌چپ را فراموش می‌کنند: خط‌هایی که فارسی و انگلیسی دارند علامت‌گذاری‌شان به‌هم می‌ریزد، جدول‌ها برعکس می‌شوند و بلوک کد جهت اشتباه می‌گیرد. Noviq از اول برای این ساخته شده: جهت متن **برای هر بلوک جدا** تعیین می‌شود، متن ترکیبی درست نمایش داده می‌شود و بقیه‌ی چیزها (جدول، لیست، Callout، فرمول، نمودار) از آن پیروی می‌کنند.

یادداشت‌های شما فایل‌های ساده در پوشه‌ای هستند که مال خودتان است. سرور Noviq وجود ندارد و ثبت‌نام هم لازم نیست. اگر یادداشت‌ها را روی چند دستگاه می‌خواهید، Noviq می‌تواند همان پوشه را از طریق Google Drive خودتان همگام کند.

## قابلیت‌ها

### ادیتور

- **جهت متن برای هر بلوک:** `/rtl`، `/ltr`، `/auto`، `Ctrl+Shift+←/→` و میانبر Word (هر دو Shift/Ctrl سمت چپ یا راست).
- **بلوک‌های غنی:** عنوان، لیست، چک‌لیست، نقل‌قول، جدول RTL، Callout، Toggle قابل‌جمع‌شدن و تصویر.
- **فرمول ریاضی** با KaTeX (`$x$` و `$$`).
- **نمودار** با [Mermaid](https://mermaid.js.org/): متن بنویسید و نمودار زنده بگیرید؛ بزرگ‌نمایی، جابه‌جایی و تبدیل به کد. چسباندن متن Mermaid خودکار تشخیص داده می‌شود.
- **بلوک کد:** ۲۴ زبان با رنگ‌آمیزی، تشخیص خودکار و تورفتگی با `Tab` و `Enter`.
- **Markdown:** شورت‌کات‌های زنده هنگام تایپ و چسباندن Markdown خام.
- **منوی دستور** با `/` و `Ctrl+/` (با کیبورد فارسی هم کار می‌کند)؛ روی متن انتخاب‌شده، همان انتخاب را تبدیل می‌کند.
- **لینک صفحه** با `[[`، `@` یا `/لینک` و **بک‌لینک** خودکار در هر صفحه.
- **جست‌وجو در صفحه** (`Ctrl+F`) که هم‌ارزی «ي/ی» و «ك/ک» و نیم‌فاصله را می‌فهمد.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/editor-blocks.png" alt="کد، فرمول، نمودار Mermaid و Toggle"></td>
<td width="50%"><img src="docs/screenshots/reader.png" alt="حالت مطالعه"></td>
</tr>
<tr>
<td align="center"><sub>کد، فرمول KaTeX، نمودار Mermaid، Toggle و بک‌لینک</sub></td>
<td align="center"><sub>حالت مطالعه: بدون حواس‌پرتی، با اندازه و عرض قابل‌تنظیم</sub></td>
</tr>
</table>

### فضای کار

- **صفحه، زیرصفحه و پوشه** با کشیدن و رها کردن، علاقه‌مندی، آیکون و کاور (گرادیان یا تصویر).
- **برچسب و وضعیت** (انجام‌نشده / در حال انجام / انجام‌شده) برای هر صفحه و **جدول صفحه‌ها** با فیلتر و مرتب‌سازی.
- **گراف** ارتباط صفحه‌ها، برای کل Vault یا اطراف صفحه‌ی جاری.
- **جست‌وجوی سریع و پالت دستور** با `Ctrl+K`.
- **قالب‌ها:** جلسه‌ی درس، خلاصه‌ی فصل، تمرین، صورت‌جلسه، فهرست کارها.
- **حالت مطالعه** (`Ctrl+.`): نمایش فقط‌خواندنی شبیه برگه، با فهرست عنوان‌ها و درصد پیشرفت.
- **چاپ / PDF** با استایل چاپ تمیز.
- **ظاهر:** تم روشن، تاریک یا سیستم، رنگ تأکید، پس‌زمینه، فونت ادیتور و رابط فارسی / انگلیسی.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/graph.png" alt="گراف"></td>
<td width="50%"><img src="docs/screenshots/table.png" alt="جدول صفحه‌ها"></td>
</tr>
<tr>
<td align="center"><sub>گراف</sub></td>
<td align="center"><sub>جدول صفحه‌ها</sub></td>
</tr>
</table>

### مطالعه و یادگیری

- **فلش‌کارت از یادداشت‌ها:** هر بلوک Toggle یک کارت است (عنوان سؤال، محتوا جواب).
- **تکرار فاصله‌دار** (به سبک SM-2) با نمره‌های *دوباره / سخت / خوب / آسان*، برای یک صفحه یا کل Vault.

<img src="docs/screenshots/flashcards.png" alt="مرور فلش‌کارت" width="70%">

### داده‌ی شما

- **فایل باز، نه دیتابیس بسته.** صفحه‌ها JSON هستند و پیوست‌ها فایل‌هایی با نام بر پایه‌ی هش.
- **تاریخچه‌ی نسخه‌ها:** تا ۴۰ نسخه برای هر صفحه، با پیش‌نمایش و بازگردانی.
- **سطل زباله‌ی ۳۰ روزه**؛ تصویرهای بی‌مرجع بعد از یک مهلت پاک می‌شوند.
- **وارد کردن** فایل‌های Markdown و **Vault ابسیدین** (پوشه‌ها، `[[لینک|alias]]`، `![[تصویر]]`، تگ‌ها، front matter و callout).
- **خروجی** zip (ساختار پوشه‌ای، `assets/` و front matter) یا پشتیبان JSON.

### شخصی‌سازی

<table>
<tr>
<td width="50%"><img src="docs/screenshots/dark.png" alt="تم تاریک"></td>
<td width="50%"><img src="docs/screenshots/settings.png" alt="تنظیمات ظاهر"></td>
</tr>
<tr>
<td align="center"><sub>تم تاریک</sub></td>
<td align="center"><sub>تم، رنگ تأکید و پس‌زمینه</sub></td>
</tr>
</table>

## دانلود

آخرین نصب‌کننده را از صفحه‌ی **[Releases](https://github.com/AliMirzad/noviq/releases)** بگیرید:

| سیستم‌عامل | فایل |
|---|---|
| ویندوز ۱۰ / ۱۱ | `.exe` (NSIS) یا `.msi` |
| مک (Intel و Apple Silicon) | `.dmg` (یونیورسال) |

> **هشدار اجرای اول.** نصب‌کننده‌ها هنوز امضای دیجیتال ندارند.
> در **ویندوز** ممکن است SmartScreen هشدار «Unknown publisher» بدهد: *More info ← Run anyway*.
> در **مک** بار اول روی برنامه راست‌کلیک کنید و *Open* را بزنید.

## سینک با Google Drive

سینک اختیاری است و به هیچ سرور Noviq نیاز ندارد.

1. روی کارت فضای کار پایین سایدبار بزنید تا **Workspaces** باز شود و با حساب Google وارد شوید.
2. Noviq پوشه‌ی شما را با یک پوشه‌ی مخفی برنامه در Google Drive **خودتان** هماهنگ نگه می‌دارد.
3. Noviq را روی کامپیوتر دیگر نصب کنید، وارد شوید و همان Vault ظاهر می‌شود.

دسترسی‌ها:

- Noviq فقط scope به نام **`drive.appdata`** را می‌خواهد (و ایمیل شما برای نمایش حساب متصل). فقط به پوشه‌ی مخفی خودش دسترسی دارد و به **هیچ فایل دیگری** در Drive شما نه.
- توکن ورود در محل امن سیستم‌عامل ذخیره می‌شود (Windows Credential Manager / macOS Keychain).
- یادداشت‌ها مستقیم بین دستگاه شما و Google جابه‌جا می‌شوند. [سیاست حریم خصوصی](https://alimirzad.github.io/noviq/privacy.html) را ببینید.

وقتی دو دستگاه یک صفحه را ویرایش کنند، چیزی بی‌صدا گم نمی‌شود: ویرایش جدیدتر می‌ماند و قدیمی‌تر در تاریخچه‌ی همان صفحه نگه داشته می‌شود. صفحه‌های مختلف هرگز با هم conflict ندارند.

## داده چطور ذخیره می‌شود

**Vault** یک پوشه‌ی معمولی است (پیش‌فرض `Documents/Noviq`) و تنها منبع حقیقت؛ بقیه‌ی چیزها مشتق‌شده و قابل بازسازی‌اند.

</div>

```
MyVault/
  .noviq/vault.json            نسخه‌ی قالب Vault
  pages/<id>.json              هر صفحه یا پوشه یک فایل (سند TipTap + متادیتا)
  files/ab/<sha256>            پیوست‌ها (نام‌گذاری بر پایه‌ی هش؛ هیچ‌وقت conflict ندارند)
  history/<pageId>/<ts>.json   نسخه‌های قبلی صفحه (تا ۴۰ تا)
  kv/<key>.json                تنظیمات هم‌گام (مثل زمان‌بندی فلش‌کارت‌ها)
  .trash/                      حذف‌شده‌ها، ۳۰ روز بعد پاک‌سازی می‌شوند
```

<div dir="rtl">

نام فایل‌ها شناسه است نه عنوان، پس تغییر نام و جابه‌جایی conflict نمی‌سازد؛ هر نوشتن atomic است (فایل موقت ← `fsync` ← rename)؛ هر ویرایش دقیقاً یک فایل را تغییر می‌دهد. دلیل این تصمیم‌ها در [ADR-0003](docs/adr/0003-vault-and-sync.md) آمده است.

## ساخته‌شده با

| | |
|---|---|
| پوسته | [Tauri 2](https://tauri.app/) (Rust) |
| رابط | React 19، TypeScript، Vite |
| ادیتور | [TipTap 3](https://tiptap.dev/) (ProseMirror) |
| فرمول / نمودار | KaTeX، Mermaid |
| ذخیره‌سازی | فایل ساده در پوشه‌ی Vault؛ IndexedDB هنگام اجرا در مرورگر |
| سینک | Google Drive API (`appDataFolder`)، OAuth 2.0 با PKCE |

## ساخت از سورس

**پیش‌نیازها:** Node.js نسخه‌ی ۲۲٫۱۸ به بالا، Rust (stable) و [پیش‌نیازهای Tauri](https://tauri.app/start/prerequisites/) برای سیستم‌عامل شما (ویندوز: Visual Studio Build Tools با *Desktop development with C++*؛ مک: Xcode Command Line Tools).

</div>

```bash
git clone https://github.com/AliMirzad/noviq.git
cd noviq/spike/tiptap
npm install
```

```bash
npm run tauri dev      # اپ دسکتاپ در حالت توسعه
npm run dev            # فقط رابط وب در مرورگر (http://localhost:5173)
npm run tauri build    # نصب‌کننده برای سیستم‌عامل فعلی (src-tauri/target/release/bundle/)
```

<div dir="rtl">

### سینک Google Drive در بیلد خودتان

کلید OAuth مال برنامه است نه کاربر. در Google Cloud یک OAuth client از نوع **Desktop app** بسازید (Drive API فعال، scope به نام `drive.appdata`) و سپس یکی از این دو را انجام دهید:

- متغیرهای محیطی `NOVIQ_GOOGLE_CLIENT_ID` و `NOVIQ_GOOGLE_CLIENT_SECRET` را موقع بیلد تنظیم کنید، یا
- فایل JSON دانلودشده را با نام `google-oauth.json` در پوشه‌ی app-data برنامه بگذارید.

بدون این کلیدها برنامه کاملاً آفلاین کار می‌کند و فقط دکمه‌ی سینک در دسترس نیست.

### آزمون‌ها

</div>

```bash
# Node 22.18+ (از node:sqlite استفاده می‌کند و TypeScript را مستقیم اجرا می‌کند)
for t in schema crash zip detect srs mermaid-detect; do node db/test-$t.mjs; done
node db/check-i18n.mjs                         # رشته‌های t('…') بدون ترجمه‌ی فارسی
cd spike/tiptap/src-tauri && cargo test        # Rust
cd .. && npx tsc -b                            # بررسی نوع‌ها
```

<div dir="rtl">

## انتشار نسخه

نصب‌کننده‌های ویندوز و مک با [GitHub Actions](.github/workflows/release.yml) ساخته می‌شوند.

1. `version` را در `tauri.conf.json`، `Cargo.toml` و `package.json` (در `spike/tiptap`) بالا ببرید.
2. دو secret به نام‌های `NOVIQ_GOOGLE_CLIENT_ID` و `NOVIQ_GOOGLE_CLIENT_SECRET` را در مخزن اضافه کنید.
3. تگ بزنید و push کنید:

</div>

```bash
git tag v0.1.0
git push origin v0.1.0
```

<div dir="rtl">

4. Draft ساخته‌شده را بررسی کنید و منتشر کنید.

## ساختار مخزن

| مسیر | محتوا |
|---|---|
| `spike/tiptap/` | خود برنامه: رابط React (`src/`) و پوسته‌ی Tauri (`src-tauri/`) |
| `spike/tiptap/src-tauri/src/` | Rust: `vault`، `index`، `registry`، مهاجرت `legacy` و `sync/` (ورود Google و Drive) |
| `db/` | migrationهای SQLite، نرمال‌سازی فارسی و آزمون‌های Node |
| `docs/` | مستندات طراحی، [ADRها](docs/adr/) و سایت پروژه |

## نقشه‌ی راه

- نصب‌کننده‌های امضاشده (ویندوز و مک) و به‌روزرسانی خودکار
- اپ موبایل (iOS / Android) روی همان قالب Vault
- کار همزمان از طریق یک سرور اختیاری (قالب صفحه از قبل مستقل از backend است؛ ADR-0003)
- ایندکس SQLite محلی برای جست‌وجو و بک‌لینک در Vaultهای خیلی بزرگ

## حریم خصوصی

Noviq کاملاً روی کامپیوتر شما اجرا می‌شود. تحلیل رفتار (analytics) و telemetry ندارد و یادداشت‌های شما را هرگز برای ما نمی‌فرستد. تنها ترافیک شبکه با Google است، آن هم فقط اگر سینک را روشن کنید. جزئیات: [سیاست حریم خصوصی](https://alimirzad.github.io/noviq/privacy.html).

---

<div align="center">
<sub>ساخته‌ی Vexor</sub>
</div>

</div>
