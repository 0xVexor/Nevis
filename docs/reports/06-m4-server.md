# گزارش 06: M4 — سرور واقعی (حساب، نشست، workspace، دستگاه) و ورود در وب

- تاریخ: 2026-11-21 · تگ: `m4` · commitها: `c06b545` (سرور)، `0abd0dc` (هستهٔ کلاینت/ابزار)، و commit نهایی M4 (ورود وب + docs؛ `git log m4`).
- هدف: سرور Go قابل استفادهٔ واقعی با حساب و نشست امن برای وب (کوکی) و دستگاه (توکن)، و کلاینت وب که به‌جای `DEV_TOKEN` وارد می‌شود.
- وضعیت: **بخش خودکار کامل و سبز.** چک‌لیست iPhone/Safari با مالک است (`docs/checklists/M4.md`). Safari/iPhone واقعی آزموده نشده؛ فقط WebKit مربوط به Playwright.

## چه ساخته شد
**سرور (`server/`)**
- `internal/auth`: `password.go` (scrypt)، `pow.go` (PoW ثبت‌نام)، `limiter.go`، `auth_test.go` — **کپی از سرور قدیمی** (`/Users/wrangler/Developer/Projects/Nevis/.claude/worktrees/web/server/internal/auth/`) بدون تغییر منطق؛ `internal/apierr` هم‌چنین. پکیج `vaults` و مسیرهای path/CAS نیامدند.
- `internal/store/accounts.go`: حساب، دستگاه، نشست (فقط SHA-256 توکن در DB)، workspace، عضو (`owner|editor|viewer`)، `AddMember`، سهمیه (`used_bytes`)، `waiters.go` برای long-poll.
- `internal/api`: `auth.go` (signup/signin/recover/signout/me/devices)، `ws.go` (فهرست/ساخت workspace، push، pull با `wait` تا ۲۵s)، `middleware.go` (`Nevis-Proto` و ۴۲۶، CSRF با Origin==Host، کوکی)، `web.go` (`WEB_DIR` با CSP سخت‌گیر).
- متغیرهای محیط: `DEV_MODE`، `DEV_TOKEN`، `SESSION_SECRET` (≥۳۲ کاراکتر، الزامی)، `REGISTRATION` (`open|invite|closed`)، `INVITE_CODES`، `POW_BITS`، `QUOTA_MB`، `WEB_DIR`، `PORT`، `LISTEN_HOST`، `DATA_DIR`.

**هستهٔ کلاینت**
- ترمیم `422 clock_ahead`: موتور opهای ردشده را نگه می‌دارد و `meta.clockAhead=1` می‌گذارد؛ وقتی ساعت درست شد opهای با HLC آینده را با همان محتوا و op id/HLC تازه بازمی‌سازد و رجیسترها/رویدادهای محلی را در **یک تراکنش** rekey می‌کند (`Tx.rekeyField/rekeyEvent`، در `MemoryStore` و `IdbStore` و conformance). فایل‌ها: `packages/core/src/clockRepair.ts`، `engine.ts`.
- فهرست خطاها: `packages/protocol/vectors/errors.json` (۲۸ کد) مشترک بین TS (`errors.ts`) و Go (`errors_catalog_test.go`).

**ابزار و وب**
- `tools/nevis-log` (`pnpm nevis-log --server URL --user NAME [--ws ID]`): ورود به‌عنوان دستگاه، کشیدن لاگ، و چاپ خوانا (decode در کلاینت؛ سرور payload را نمی‌بیند). بدون `--ws` فهرست workspaceها. توجه: برای `yupd` فقط محتوای **همان update** نشان داده می‌شود نه سند کامل.
- `tools/converge --user/--password` (حساب واقعی) و `--clock-ahead`.
- `apps/web`: `auth.ts` (کلاینت کوکی؛ PoW با `crypto.subtle`)، `main.tsx` (فرم ورود/ثبت‌نام فارسی، نمایش یک‌بارهٔ کلید بازیابی، فهرست فضاهای کار، فضای کار تازه، خروج). مسیر `?ws=<id>` هنوز با `DEV_TOKEN` بدون ورود کار می‌کند (آزمون‌های Playwright قدیمی).
- `server/scripts/demo.sh`: build وب + سرور و اجرای یک سرور same-origin روی ۸۷۸۸.

## نتایج (اجرا شده)
- `go test -race ./...` سبز؛ `go vet` تمیز. TS: protocol ۶۵، schema ۲۵، m1-editor ۶، core ۲۶، store-idb ۱۰، converge ۴ — همه سبز. Playwright ۳ موتور: ۲۲ سبز، ۲ skip عمدی (`engines.spec` فقط Chromium).
- معیارهای ROADMAP: ۱ `TestSignUpInRecoverLikeTheOldServer`؛ ۲ `TestCSRFGuard`؛ ۳ `TestWebSessionCookieAndTokenAtRest`؛ ۴ و ۶ `TestAnotherAccountCannotSee…`، `TestRevokedDeviceIs401…`؛ ۵ `TestProtocolVersionGates`؛ ۷ `TestPushThroughputWithRealAccounts` = **۳۴٬۵۹۰ op/s** (هدف ۲۰۰۰)؛ ۸ و ۱۰ converge با حساب واقعی (۱۰ seed) و clock-ahead (۲۰ seed، ۱۶۸ رد ۴۲۲ واقعی، همگرا، بدون op گم‌شده)؛ ۹ `TestLongPollWakesOnACommitAndTimesOutEmpty`؛ بردارها: envelope ۲۶، json ۲۳، errors ۲۸.
- کوکی در ۳ موتور (Playwright): `HttpOnly`، `SameSite=Strict`، از `document.cookie` پنهان، reload و تب دوم وارد می‌مانند، خروج پاکش می‌کند، خروج یک مرورگر دیگری را بیرون نمی‌اندازد. build تولیدی زیر CSP سخت‌گیر ثبت‌نام و سینک می‌کند (دستی با `tests/prod-csp.mjs`).

## کار نمی‌کند / آزموده نشده / انحراف از ROADMAP
- **iPhone/Safari واقعی و ماندگاری ۲۴ ساعته** آزموده نشده (چک‌لیست مالک).
- `go run ./server/cmd/smoke` ساخته **نشد**: `nevis-log` + converge با حساب واقعی + آزمون‌های Go همان پوشش را می‌دهند. دمو با curl هم جایگزین شد با `demo.sh` (یک سرور کامل) — اگر curl-script خواستید، اضافه می‌شود.
- در dev، پروکسی Vite باید Host را عوض نکند (`changeOrigin: false`) وگرنه محافظ CSRF (Origin==Host) درست ۴۰۳ می‌دهد؛ پشت reverse proxy واقعی هم همین الزام است. در `vite.config.ts` اعمال شد.
- لاگ کنسول مرورگر یک 401 (پرسش `/v1/me` پیش از ورود) نشان می‌دهد؛ طبیعی است.
- ورود/خروج در UI فعلاً بخشی از «آزمایشگاه M3» است؛ UI نهایی در M5/M8.
- گذرواژه فراموش‌شده فقط با کلید بازیابی؛ UI بازیابی ساخته نشد (API هست).

## تصمیم‌ها
مطابق ADR-0006/0007: توکن نشست وب هرگز در JSON نمی‌آید؛ دستگاه توکن bearer می‌گیرد؛ غریبه برای workspace دیگری ۴۰۴ می‌بیند؛ viewer نمی‌نویسد؛ سهمیه per حساب.

## قدم بعدی دقیق
M5 — برش عمودی وب: صفحه + بدنهٔ Yjs + سینک واقعی (`docs/ROADMAP.md` بخش M5). از `packages/schema` و `spikes/m1-editor` برای ادیتور و از `Lab` (`apps/web/src/lab.ts`) برای الگوی شروع Client/Engine/TabCoordinator استفاده کنید.

## ادامه از صفر
```bash
cd /Users/wrangler/Developer/Projects/nevis-next
corepack pnpm install
corepack pnpm test && (cd server && go test -race ./...)
corepack pnpm --filter web exec playwright test      # ۳ موتور؛ سرور Go را خودش بالا می‌آورد
server/scripts/demo.sh                               # http://localhost:8788
corepack pnpm nevis-log --server http://localhost:8788 --user NAME   # (اسکریپت ریشه pnpm را صدا می‌زند؛ بدون pnpm در PATH: corepack pnpm --filter @nevis/nevis-log start ...)
```
