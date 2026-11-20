# R3: پوسته‌ها (Shells) و موبایل برای Nevis

تاریخ دسترسی به منابع: 2026-11-20. برچسب‌ها: [source] = منبع اولیه یا رسمی که خودم خواندم (یا خلاصه آن را دیدم، با یادداشت)؛ [secondary] = وبلاگ، فوروم، یا نتیجه جستجو؛ [inference] = استنتاج من.

## معنای این برای تصمیم ما

1. آخرین نسخه Tauri 2.x در صفحه releases، `tauri v2.12.7` با تاریخ «18 Nov» است؛ سال در صفحه نیامد و 2026 فرض شده است [source: https://github.com/tauri-apps/tauri/releases + [inference]].
2. یادداشت‌های انتشار آخرین نسخه Tauri هیچ بخشی درباره iOS یا Android ندارد [source: همان صفحه].
3. مستندات رسمی Tauri برای App Store فقط Apple را پوشش می‌دهد و هیچ وضعیت «آماده تولید» بودن موبایل را بیان نمی‌کند [source: https://v2.tauri.app/distribute/app-store/، 2026-11-20].
4. README پلاگین updater در Tauri، Android و iOS را «پشتیبانی نمی‌شود» نشان می‌دهد؛ updater فقط دسکتاپ است [source: https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/updater/README.md].
5. Issue #9907 در Tauri («iOS pop-up keyboard causes webview to move outside the screen») از 2024-05-29 باز است؛ آخرین کامنت 2026-09-17 است و مسئول پروژه پاسخی نداده [source: https://github.com/tauri-apps/tauri/issues/9907].
6. آخرین نسخه Capacitor در GitHub، `8.6.2` با تاریخ 2026-11-12 است [source: https://github.com/ionic-team/capacitor/releases].
7. `@capacitor-community/sqlite` آخرین نسخه `v8.1.1` را 2026-08-06 منتشر کرده است؛ نگهدارنده فعلی Capawesome است [source: https://github.com/capacitor-community/sqlite].
8. Background Runner رسمی Ionic: iOS حدود 30 ثانیه در هر اجرا و زمان‌بندی با سیستم؛ Android حداکثر 10 دقیقه [source: https://github.com/ionic-team/capacitor-background-runner].
9. در iOS، `BGContinuedProcessingTask` از iOS 26 به بعد برای کار کاربرمحور در foreground است و سیستم می‌تواند آن را ناگهان متوقف کند؛ `BGProcessingTask` فقط وقتی دستگاه بیکار است اجرا می‌شود و با استفاده کاربر متوقف می‌شود [source: Apple developer docs، 2026-11-20].
10. Android 15+: سرویس foreground نوع `dataSync` حداکثر 6 ساعت در 24 ساعت؛ سپس `onTimeout()` [source: developer.android.com، از نتیجه جستجو؛ صفحه مستقیم 403].
11. Google Play: از 2026-08-31 اپ‌های جدید و به‌روزرسانی‌ها باید Android 16 (API 36) را هدف قرار دهند [source: https://developer.android.com/google/play/requirements/target-sdk، از نتیجه جستجو].
12. Apple برای اپ‌های با login، حساب demo یا demo mode کامل (2.1(a))، و برای اپ‌های با ساخت حساب، حذف حساب داخل اپ (5.1.1(v)) را می‌خواهد [source: https://developer.apple.com/app-store/review/guidelines/، 2026-11-20].

## 1. Tauri 2 روی موبایل

| موضوع | وضعیت | برچسب |
|---|---|---|
| بلوغ تولید | Tauri 2.0 پایدار شد؛ اعلام RC گفت می‌توان اپ موبایل تولیدی ساخت، اما موبایل هنوز «first-class» نیست. تاریخ 2024-10-02 از خلاصه جستجو آمده است. | [secondary] https://v2.tauri.app/blog/tauri-20/ (صفحه برای من خوانده نشد) |
| اپ موبایل تولیدی با Tauri | اپ تولیدی iOS/Android شناخته‌شده با منبع معتبر پیدا نکردم. نام‌های دسکتاپ (Spacedrive، Clash Verge) را یک وبلاگ آورده؛ AppFlowy با Flutter و Rust ساخته شده و Tauri نیست [source: https://github.com/AppFlowy-IO/AppFlowy]. | ندانسته / [secondary] |
| فرایند iOS | `tauri ios build --export-method app-store-connect`، آپلود با `altool` و API key؛ نیاز به Apple Developer Program و macOS | [source] https://v2.tauri.app/distribute/app-store/ |
| فرایند Android | ساخت AAB پیشنهاد شده است؛ جزئیات از راهنمای ثالث | [secondary] |
| پلاگین fs، deep-link، dialog | README هر سه: Android ✓ و iOS ✓ | [source] (خلاصه مدل از README خام) |
| پلاگین sql | README جدول پنج سکو را «✓» می‌دهد؛ درایورها sqlite، mysql، postgres | [source] (خلاصه مدل از README خام) |
| پلاگین notification | README همه پنج سکو را «✓» می‌دهد | [source] (خلاصه مدل) |
| پلاگین biometric | Android ✓، iOS ✓ با قید «no biometric cryptography»، macOS ✓ | [source] (خلاصه مدل) |
| پلاگین stronghold (secure storage) | README: Android ✓ و iOS ✓؛ بدون یادداشت deprecation یا نگه‌داری | [source] (خلاصه مدل از README خام) |
| پلاگین updater | فقط دسکتاپ؛ Android و iOS «x» | [source] README |
| Keychain بومی | پلاگین رسمی مستقل ندیدم؛ کد Swift/Kotlin یا پلاگین سفارشی لازم است | [inference] |
| کیبورد iOS | Issue #9907 باز؛ `visualViewport` کار نکرد (کامنت کاربر) | [source] |
| کیبورد و IME Android | گزارش: `visualViewport` تغییر نمی‌کند؛ راه‌حل کاربر `setOnApplyWindowInsetsListener` | [secondary] Zenn (فقط جستجو) |
| Safe area | پلاگین جامعه `tauri-plugin-edge-to-edge` (آخرین انتشار 2025-11) و `tauri-plugin-ios-webview-insets` | [secondary] lib.rs/docs.rs |
| Build/CI | Xcode، Android SDK و NDK لازم است؛ نسخه‌های دقیق در صفحه نبود | [source] https://v2.tauri.app/start/prerequisites/ |
| Update در موبایل | updater رسمی فقط دسکتاپ است؛ در iOS/Android به‌روزرسانی از طریق استور | [inference] |
| حجم | Tauri کوچک‌تر از Electron معمولاً است؛ اعداد جستجو پراکنده است | [secondary] |

## 2. Capacitor، Ionic و گزینه‌های دیگر

| گزینه | وضعیت | نکته برای Nevis |
|---|---|---|
| Capacitor 8.x | 8.6.2 در 2026-11-12؛ مستندات capacitorjs.com برای من 403 داد | بالغ‌ترین WebView-based برای موبایل [inference] |
| پلاگین push | مستندات رسمی نسخه 3 می‌گوید iOS silent push پشتیبانی نمی‌شود [source: https://capacitorjs.com/docs/v3/apis/push-notifications؛ نسخه قدیمی است]؛ برای اعلان‌های iOS ممکن است native لازم باشد | [inference] برای نسخه فعلی |
| `@capacitor-community/sqlite` | 8.1.1؛ SQLCipher برای native؛ وب با jeep-sqlite و IndexedDB؛ Electron با better-sqlite3-multiple-ciphers | گزینه SQLite موبایل |
| Background Runner | JS در محیط مستقل روی BGTask و WorkManager، با محدودیت‌های بخش 4 | مهم‌ترین مکانیزم Capacitor برای outbox پس‌زمینه |
| Ionic | لایه UI روی Capacitor؛ ارزش افزوده برای TS-core محدود است | [inference] |
| React Native / Expo | UI native؛ UI باید دوباره نوشته شود | [inference] |
| PWA فقط | کمترین هزینه؛ محدودیت iOS در background و storage | [inference] |
| Electron در مقابل Tauri (دسکتاپ) | Electron بزرگ‌تر؛ Tauri کوچک‌تر با WebView سیستمی؛ Linux با WebKitGTK مشکل‌سازتر | [secondary] tech-insider.org؛ capawesome.io |
| Logseq (نمونه واقعی) | فایل `capacitor.config.ts` در مخزن Logseq با appId `com.logseq.app` و webDir `static/mobile` وجود دارد؛ یعنی موبایل Logseq با Capacitor ساخته می‌شود | [source] github.com/logseq/logseq (نسخه master در 2026-11-20) |

الگوی «Capacitor موبایل + Tauri دسکتاپ با یک codebase» در منبع اولیه‌ای که پیدا کردم نیامد؛ فقط مقاله Capawesome درباره مقایسه Electron و Tauri برای اپ Capacitor بود [secondary: https://capawesome.io/docs/blog/electron-vs-tauri-for-capacitor-apps/].

## 3. تفاوت WebView

| API / قابلیت | نکته | برچسب |
|---|---|---|
| IndexedDB | در همه سکوها؛ eviction در iOS محتمل است | [inference] |
| OPFS و `createSyncAccessHandle` | فقط در Dedicated Worker و فقط در secure context؛ `https`، `localhost` و `*.localhost` امن‌اند، ولی scheme سفارشی مثل `tauri://` خودبه‌خود امن نیست مگر مرورگر آن را authenticated بداند؛ Baseline از مارس 2023 | [source] MDN Secure Contexts و FileSystemSyncAccessHandle؛ وضعیت WKWebView = ندانسته |
| Web Locks | Baseline از مارس 2022 | [source] MDN |
| BroadcastChannel | Baseline از مارس 2022 | [source] MDN |
| Service Worker روی `tauri://` در iOS | در WKWebView با custom scheme ثبت نمی‌شود، طبق bug WebKit؛ اپل گفته راه پشتیبانی‌شده‌ای نیست | [secondary] https://bugs.webkit.org/show_bug.cgi?id=206741 |
| Origin در Tauri | گزارش‌ها: Windows و Android از `http` استفاده می‌کنند؛ Apple از `tauri://`؛ تغییر origin یعنی IndexedDB/OPFS جدید خالی می‌شود | [secondary] release notes v2، [inference] برای اثر |
| گزینه `use_https_scheme` | پیش‌فرض false؛ اگر true باشد origin در Windows و Android از `http://<scheme>.localhost` به `https://<scheme>.localhost` تغییر می‌کند، پس داده IndexedDB/OPFS قبلی در origin جدید دیده نمی‌شود | [source] docs.rs/tauri-utils؛ اثر روی داده = [inference] |
| File System Access API | در WebKit پشتیبانی ندارد؛ در دسکتاپ Tauri باید از پلاگین fs استفاده شود | [inference] |
| Intl.Segmenter | در WebKit و Android WebView حاضر است؛ WebKitGTK بسته به توزیع فرق دارد | [inference] |
| فونت فارسی و IME فارسی | بدون تست و بدون منبع | ندانسته |
| viewport و کیبورد | Issue #9907 و کیبورد Android (بخش 1) | [source/secondary] |
| .localhost در Windows و Android | Tauri 2.11.1 یک اصلاح برای این موضوع داده است | [secondary] |

جمع‌بندی: با TS-core و IndexedDB یا OPFS می‌شود کار کرد، اما Service Worker به‌عنوان مکانیزم offline روی iOS Tauri قابل اعتماد نیست؛ و تغییر origin بین نسخه‌ها داده محلی را جدا می‌کند [inference].

## 4. اجرای پس‌زمینه

| پلتفرم | مکانیزم | محدودیت | برچسب |
|---|---|---|---|
| iOS | `BGAppRefreshTask` | کوتاه، برای refresh؛ تضمین زمان ندارد | [source] Apple (بدون عدد زمان) |
| iOS | `BGProcessingTask` | فقط وقتی دستگاه بیکار؛ با استفاده کاربر متوقف | [source] Apple |
| iOS 26+ | `BGContinuedProcessingTask` | شروع در foreground با کنش کاربر؛ Live Activity؛ سیستم ممکن است ناگهان قطع کند؛ برای GPU نیاز به entitlement | [source] Apple |
| iOS silent push | محدود و به زمان سیستم وابسته | — | [inference] + [source] نسخه قدیمی Capacitor |
| Android | WorkManager | زمان‌بندی توسط سیستم؛ Doze و battery | [source] نتیجه جستجو |
| Android `dataSync` foreground | 6 ساعت در 24 ساعت (Android 15+) | برای sync دائمی مناسب نیست | [source] نتیجه جستجو |
| Capacitor Background Runner | iOS حدود 30 ثانیه؛ Android حداکثر 10 دقیقه؛ تکرار حداقل 15 دقیقه | زمان‌بندی توسط سیستم | [source] |
| WebView پس‌زمینه | JS معمولاً متوقف می‌شود؛ outbox باید در بازگشت به foreground یا با native ارسال شود | — | [inference] |

انتظار واقع‌بینانه برای اپ یادداشت: همگام‌سازی هنگام باز بودن اپ و ارسال outbox هنگام بازگشت به foreground یا در بازه‌های سیستم؛ «لحظه‌ای» در پس‌زمینه تضمین ندارد. Obsidian، طبق گزارش کاربران در فوروم، روی iOS همگام‌سازی پس‌زمینه را عملاً فقط هنگام باز بودن اپ انجام می‌دهد [secondary: https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906]. Anytype و Joplin را با منبع اولیه بررسی نکردم.

## 5. SQLite: گزینه‌ها و هزینه یک interface

| گزینه | دسکتاپ | موبایل | هزینه |
|---|---|---|---|
| Tauri SQL plugin (sqlx) | بله؛ sqlite، mysql، postgres با feature flag | README جدول پنج سکو را «✓» می‌دهد | [source] README؛ sqlx [inference] |
| rusqlite از طریق command Tauri | بله | ساخت برای هر سکو | [inference] |
| `@capacitor-community/sqlite` | بله (Electron با better-sqlite3-multiple-ciphers) | iOS و Android؛ Web با jeep-sqlite | [source] |
| SQLite در WASM (OPFS یا IndexedDB) | در وب و PWA | — | [inference] |

هزینه یک interface: یک interface در TS با تراکنش، query، migration و watch، و حداقل سه driver. تفاوت‌های اصلی تراکنش، concurrency بین تب‌ها در وب، و eviction در WebKit است [inference]. تست عملکرد این تفاوت‌ها را انجام ندادم.

## 6. توزیع، امضا، به‌روزرسانی، قوانین استور

| موضوع | واقعیت | برچسب |
|---|---|---|
| Apple | Bundle ID در `tauri.conf.json` باید با App Store Connect یکی باشد؛ notarization برای macOS را نتوانستم از صفحه رسمی بخوانم | [source] Tauri App Store؛ notarization = ندانسته |
| Windows | OV/EV و Azure Artifact Signing؛ EV از 2024 دیگر «reputation فوری» در SmartScreen ندارد | [source] https://v2.tauri.app/distribute/sign/windows/ |
| Tauri updater | امضای اجباری («cannot be disabled») | [source] https://v2.tauri.app/plugin/updater/ |
| Google Play | target API 36 تا 2026-08-31 | [source] (نتیجه جستجو) |
| 4.2 | اپ نباید «repackaged website» باشد | [source] Apple guidelines |
| 2.5.2 | اپ نباید کدی دانلود کند که عملکرد را تغییر دهد | [source] متن 2.5.2؛ تفسیر این‌که OTA JS رد می‌شود = [inference] |
| 5.1.1(v) | حذف حساب داخل اپ اگر ساخت حساب هست | [source] |
| 2.1(a) | حساب demo یا demo mode کامل؛ سرور باید برای داوران در دسترس باشد | [source] + [inference] برای سرور self-hosted |

## ندانسته‌ها

- صفحات Capacitor docs، Google Play target-SDK و Android service timeouts در مستقیم 403 دادند؛ این موارد از جستجو یا خلاصه مدل آمده‌اند.
- صفحه Tauri 2.0 blog و صفحه Google Play Tauri برای خواندن مستقیم نرسید.
- سال 2026 برای نسخه‌های Tauri از روی صفحه نیامده است.
- هیچ اپ تولیدی iOS یا Android با Tauri 2 را با منبع معتبر تأیید نکردم.
- Persian IME، رندر فونت و RTL در WKWebView، WebKitGTK و Android WebView تست نشده است.
- Anytype و Joplin را با منبع اولیه بررسی نکردم.
- وضعیت OPFS در WKWebView با origin `tauri://` و اینکه آیا این origin امن حساب می‌شود، تأیید نشد. اگر امن نباشد، `createSyncAccessHandle` در iOS و macOS در دسترس نیست و توصیه OPFS در `storage-and-sync-options.md` (بخش C-3) باید در Apple بازبینی شود [inference].
- Service Worker روی `tauri://` در iOS فقط از bug WebKit و فوروم استنتاج شد، نه از تست.
- notarization را از صفحه رسمی Tauri نخواندم.
- زمان‌های BGAppRefreshTask (حدود 30 ثانیه) را تأیید نکردم؛ Apple در صفحه‌اش عدد نداد.
- حجم باینری‌ها و تعداد اپ‌های تولیدی، با بنچمارک مستقل تأیید نشده‌اند.
