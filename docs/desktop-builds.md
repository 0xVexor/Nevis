# ساخت نسخهٔ دسکتاپ از برنچ جاری

پوش معمولی دیگر نصب‌کننده نمی‌سازد. این اسکریپت از checkout جاری استفاده می‌کند؛ نام برنچ ثابت نیست و هیچ مرج، نصب برنامه، انتشار عمومی یا تغییری در برنچ اصلی انجام نمی‌دهد.

## ساخت روی سیستم فعلی

از داخل پوشهٔ پروژه:

```sh
node scripts/build-desktop.mjs
```

روی مک یک بستهٔ Universal برای Intel و Apple Silicon می‌سازد؛ روی ویندوز x64 فایل نصب `.exe` می‌سازد. خروجی به‌همراه `SHA256SUMS.txt` و `BUILD-INFO.json` در `artifacts/github-preview/macos` یا `artifacts/github-preview/windows` قرار می‌گیرد. فایل مشخصات، کامیت، برنچ و وجود تغییرات کامیت‌نشده را ثبت می‌کند؛ فایل محلی دارای تغییرات کامیت‌نشده پسوند `-dirty` دارد.

پیش‌نیازها: Node.js 22.12+ یا 24+، Rust/rustup و ابزارهای بومی Tauri سیستم‌عامل (روی مک Xcode Command Line Tools؛ روی ویندوز C++ Build Tools و WebView2). اگر وابستگی‌های npm نصب نباشند، اسکریپت `npm ci` را اجرا می‌کند. روی مک targetهای هر دو معماری را از طریق rustup آماده می‌کند. می‌توانید در `spike/tiptap` هم `npm run desktop:build` را اجرا کنید.

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
