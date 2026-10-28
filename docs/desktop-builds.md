# ساخت نسخهٔ دسکتاپ از برنچ جاری

پوش معمولی دیگر نصب‌کننده نمی‌سازد. این اسکریپت از checkout جاری استفاده می‌کند؛ نام برنچ ثابت نیست و هیچ مرج، نصب برنامه، انتشار عمومی یا تغییری در برنچ اصلی انجام نمی‌دهد.

## ساخت روی سیستم فعلی

از داخل پوشهٔ پروژه:

```sh
node scripts/build-desktop.mjs
```

روی مک یک بستهٔ Universal برای Intel و Apple Silicon می‌سازد؛ روی ویندوز x64 فایل نصب `.exe` می‌سازد. خروجی به‌همراه `SHA256SUMS.txt` و `BUILD-INFO.json` در `artifacts/github-preview/macos` یا `artifacts/github-preview/windows` قرار می‌گیرد. فایل مشخصات، کامیت، برنچ و وجود تغییرات کامیت‌نشده را ثبت می‌کند؛ فایل محلی دارای تغییرات کامیت‌نشده پسوند `-dirty` دارد.

پیش‌نیازها: Node.js 22.12+ یا 24+، Rust/rustup و ابزارهای بومی Tauri سیستم‌عامل (روی مک Xcode Command Line Tools؛ روی ویندوز C++ Build Tools و WebView2). اگر وابستگی‌های npm نصب نباشند، اسکریپت `npm ci` را اجرا می‌کند. روی مک targetهای هر دو معماری را از طریق rustup آماده می‌کند. روی ویندوز toolchain رسمی `stable-x86_64-pc-windows-msvc` را آماده و صریحاً با target `x86_64-pc-windows-msvc` می‌سازد؛ پیش‌فرض GNU یا `CARGO_BUILD_TARGET` سیستم مسیر ساخت را تغییر نمی‌دهد. می‌توانید در `spike/tiptap` هم `npm run desktop:build` را اجرا کنید.

## ساخت هم‌زمان مک و ویندوز روی GitHub

ابتدا تغییرات را کامیت کنید. GitHub CLI باید نصب باشد و با `gh auth login` وارد حسابی شده باشید که روی `origin` اجازهٔ پوش دارد:

```sh
node scripts/build-desktop.mjs --both
```

اسکریپت SHA جاری را به یک برنچ ساخت جدید با پیشوند `build/desktop/` پوش می‌کند. checkout فعلی جابه‌جا نمی‌شود، کامیت تازه‌ای ساخته نمی‌شود و هیچ force-push، تگ یا مرجی انجام نمی‌شود. workflow هر دو نصب‌کننده را می‌سازد؛ اسکریپت منتظر نتیجه می‌ماند و artifactها را در `artifacts/github-preview/downloads/` دریافت می‌کند. برنچ ساخت برای پیگیری نتیجه باقی می‌ماند. برنچ مبدأ باید فایل‌های فعلی اسکریپت و workflow را داشته باشد؛ این قابلیت به نام مشخصی برای برنچ مبدأ وابسته نیست.

برای صف‌کردن ساخت و گرفتن لینک، بدون انتظار برای دانلود:

```sh
node scripts/build-desktop.mjs --both --no-wait
```

استفاده از یک ref ساخت با رویداد push باعث می‌شود این روش پیش از مرج workflow به برنچ اصلی هم کار کند. `workflow_dispatch` به وجود workflow در برنچ پیش‌فرض نیاز دارد. [مستندات GitHub دربارهٔ اجرای workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

## بررسی دستورها بدون ساخت

```sh
node scripts/build-desktop.mjs --dry-run
node scripts/build-desktop.mjs --both --dry-run
node --test scripts/build-desktop.test.mjs
```

`--dry-run` فقط برنامهٔ اجرا را نشان می‌دهد؛ چیزی نصب یا ساخته نمی‌شود و هیچ پوشی انجام نمی‌گیرد. ساخت محلی می‌تواند ویرایش‌های کامیت‌نشده را شامل شود؛ ساخت GitHub برای جلوگیری از خروجی مبهم به checkout تمیز نیاز دارد.

بسته‌ها همان نسخهٔ آزمایشی جداگانه با شناسه و Keychain مستقل، GitHub فعال، بدون امضا/notarization و بدون به‌روزرسان خودکار هستند. برای تست از فضای کاری جدید یا کپی داده‌ها استفاده کنید.

## خطای WebView2Loader.dll در ویندوز

Loader با خود WebView2 Runtime فرق دارد. در dependency فعلی، MSVC فایل `WebView2LoaderStatic.lib` را داخل برنامه لینک می‌کند؛ build با GNU به DLL جداگانه نیاز دارد. مسیر ساخت محلی قبلاً target را مشخص نمی‌کرد و می‌توانست این وابستگی را وارد فایل نصب کند. wrapper و workflow اکنون MSVC x64 را صریحاً انتخاب می‌کنند و collector خروجی همان target را برمی‌دارد. نیازی به کپی DLL از سایت‌های دیگر نیست. [کد رسمی dependency](https://github.com/wravery/webview2-rs/blob/main/crates/bindings/src/lib.rs)

پس از گرفتن آخرین تغییرات همین برنچ، روی ویندوز دوباره `node scripts/build-desktop.mjs` را اجرا و فایل نصب جدید را نصب کنید. ابزار C++ Build Tools مربوط به MSVC همچنان پیش‌نیاز ساخت است. نصب WebView2 Runtime در صورت نیاز همچنان توسط نصب‌کنندهٔ Tauri انجام می‌شود.
