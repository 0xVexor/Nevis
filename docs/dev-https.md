# دسترسی HTTPS برای امتحان روی iPhone

**چرا لازم است.** روی `http://192.168.x.x:5174` صفحه «secure context» نیست؛ در Safari آنجا Web Locks، `navigator.storage.persist()` و Service Worker کار نمی‌کنند و نتیجهٔ چک‌لیست M3 بی‌معنی می‌شود. `http://localhost` فقط روی خود Mac secure است.

دو راه؛ **انتخاب با شماست** (پیشنهاد من: راه ب برای امتحان‌های روزمره، راه الف برای آزمون ۷ روزه). tunnel موقت با URL متغیر قابل قبول نیست (آزمون ۷ روزه به یک origin ثابت نیاز دارد).

## راه ب: `mkcert` روی Mac (برای امتحان در همان شبکه، ۵ دقیقه)
```bash
brew install mkcert
mkcert -install                     # یک CA محلی می‌سازد و در Mac نصب می‌کند
HOST=$(scutil --get LocalHostName).local     # نام Bonjour این Mac، مثل Amirs-MacBook.local (روی iPhone بدون DNS کار می‌کند)
mkdir -p ~/.nevis-dev && cd ~/.nevis-dev
mkcert -cert-file cert.pem -key-file key.pem "$HOST" localhost 127.0.0.1
mkcert -CAROOT                      # پوشه‌ای که rootCA.pem در آن است
```
**روی iPhone (یک بار):**
1. `rootCA.pem` را با AirDrop (یا ایمیل به خودتان) بفرستید و باز کنید → «Profile Downloaded».
2. Settings ← General ← VPN & Device Management ← پروفایل mkcert ← Install.
3. Settings ← General ← About ← **Certificate Trust Settings** ← mkcert را **روشن** کنید (بدون این مرحله Safari هنوز خطا می‌دهد).

**اجرا:**
```bash
# ترمینال ۱ (سرور Go)
pnpm dev:server
# ترمینال ۲ (صفحهٔ آزمایشگاه با HTTPS)
NEVIS_TLS_CERT=$HOME/.nevis-dev/cert.pem NEVIS_TLS_KEY=$HOME/.nevis-dev/key.pem pnpm --filter web dev
```
در iPhone Safari: `https://<HOST>:5174` (مثلاً `https://Amirs-MacBook.local:5174`). باید قفل بدون هشدار ببینید؛ در صفحه «persisted()» و «★ leader» نمایش داده می‌شود.
محدودیت: Mac و iPhone در یک شبکه و بیدار؛ پایان جلسهٔ لپ‌تاپ = پایان آزمون.

## راه الف: دامنهٔ خودتان + Caddy (برای آزمون ۷ روزه و بعد از آن)
شرط: میزبانی که ۸+ روز روشن می‌ماند (ترجیحاً سرور شخصی). نمونهٔ `Caddyfile`:
```
nevis.example.com {
  reverse_proxy 127.0.0.1:5174      # برای آزمایشگاه M3 (vite preview)؛ از M4 به بعد: reverse_proxy 127.0.0.1:8787 با WEB_DIR
}
```
```bash
pnpm --filter web build && pnpm --filter web exec vite preview --host   # ترمینال روی سرور؛ /v1 به سرور Go پروکسی می‌شود
```
Caddy گواهی Let's Encrypt را خودش می‌گیرد؛ روی iPhone چیزی نصب نمی‌شود. **یادداشت:** سرور Go از M4 خودش `WEB_DIR` را سرو می‌کند و آن‌وقت `vite preview` لازم نیست.

## عیب‌یابی
- هشدار گواهی در Safari: مرحلهٔ ۳ (Certificate Trust Settings) را انجام نداده‌اید.
- صفحه باز نمی‌شود: فایروال Mac پورت ۵۱۷۴ را باز کند؛ `curl -k https://<HOST>:5174` از خود Mac.
- «leader» هیچ‌وقت نمی‌شود: صفحه secure context نیست (آدرس باید `https://` باشد).
