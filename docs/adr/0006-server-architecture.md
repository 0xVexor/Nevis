# ADR-0006: نقش و معماری سرور

- وضعیت: **تصمیم‌شده**
- اطمینان: ۸۰٪
- تاریخ: 2026-11-20
- مرتبط: ADR-0005، ADR-0011؛ تحقیق: R4 §4-6، `storage-and-sync-options.md` §D و §6؛ کد قدیمی: `Nevis/.claude/worktrees/web/server/` (README، `internal/auth`، `internal/storage`، `internal/hub`، `internal/apierr`، `internal/config`)

## زمینه
- سرور شخصی، ساده، Go (VISION قید ۵). سرور قدیمی یک باینری Go بدون cgo با SQLite (modernc) و blob با SHA-256، حساب بدون ایمیل (scrypt، recovery key، PoW، limiter)، long-poll و بکاپ دارد. مدل سینک آن (مسیر + CAS) بازنشسته می‌شود؛ بقیه ارزشمند است.

## گزینه‌ها
| گزینه | نتیجه |
|---|---|
| Hocuspocus/y-sweet کنار Go | رد: دو سرویس، فقط Yjs، بدون لاگ seq. |
| Postgres | رد: سرور شخصی تک‌باینری هدف است؛ SQLite کافی است. |
| **یک باینری Go + SQLite (WAL) + پوشهٔ blob؛ سرور «کور» نسبت به payload** | **انتخاب.** |

## تصمیم
1. **مسئولیت‌ها:** احراز هویت و نشست؛ workspace و عضویت؛ دستگاه؛ لاگ op (push/pull/long-poll/snapshot)؛ blob؛ سهمیه و rate limit؛ اعمال `minProto`/`minSv`؛ سرو کردن فایل‌های PWA (same-origin)؛ بکاپ. **هیچ** ادغام، parse محتوا، جست‌وجو یا AI.
2. **کوری قابل آزمون:** هیچ پکیج سرور `p` را decode نمی‌کند. آزمون: push با `p` تصادفی (بایت‌های بی‌معنی) باید کار کند؛ و بررسی import (اسکریپت CI) که پکیج‌های سرور به Yjs یا decoder payload وابسته نیستند.
3. **ذخیره:** `modernc.org/sqlite` (بدون cgo، مثل سرور قدیمی)، WAL، **یک اتصال نوشتن** که همهٔ نوشتن‌ها از آن می‌گذرند (یک goroutine نویسنده یا mutex + `BEGIN IMMEDIATE`) تا ترتیب commit = ترتیب `seq`. خواندن‌ها از pool جدا.
   - ادعای «modernc نوشتن را گم می‌کند» تأیید نشده (R4 §4)؛ آزمون هم‌زمانی M2 و M4 آن را می‌سنجد. اگر شکست خورد: `mattn/go-sqlite3` با cgo.

```sql
CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0,
  min_sv INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE member (ws TEXT NOT NULL, account TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
  PRIMARY KEY (ws, account));
CREATE TABLE device (id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen INTEGER, revoked_at INTEGER);
CREATE TABLE op (ws TEXT NOT NULL, seq INTEGER NOT NULL, op_id TEXT NOT NULL, doc TEXT NOT NULL, dev TEXT NOT NULL,
  by_account TEXT NOT NULL, sv INTEGER NOT NULL, kid INTEGER NOT NULL, size INTEGER NOT NULL,
  env_sha256 BLOB NOT NULL, env TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (ws, seq), UNIQUE (ws, op_id));
CREATE INDEX op_doc ON op (ws, doc, seq);
CREATE TABLE snapshot (ws TEXT NOT NULL, doc TEXT NOT NULL, seq INTEGER NOT NULL, cov INTEGER NOT NULL,
  PRIMARY KEY (ws, doc, seq));
CREATE TABLE purged (ws TEXT NOT NULL, doc TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (ws, doc));
CREATE TABLE blob (ws TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (ws, hash));
```
   `seq` از `workspace.head + 1` در همان تراکنش.
4. **سرور چه می‌بیند:** نام کاربری حساب، workspaceها و اعضا، دستگاه‌ها (نام و آخرین بازدید)، شناسهٔ op و doc، `dev`، `t` (زمان)، `sv`، `kid`، اندازه، زمان دریافت، IP؛ blobها به‌صورت هش و بایت. **در v1 (`kid=0`) payload و blobها برای مدیر سرور خواندنی‌اند** (مثل سرور قدیمی؛ README سرور باید صریح بگوید). بعد از E2EE فقط سربرگ‌ها (ADR-0011).
5. **احراز هویت:**
   - ورود: نام کاربری + رمز (scrypt) + کلید بازیابی؛ کد از `internal/auth` قدیمی **کپی و تطبیق** داده می‌شود، بازنویسی نمی‌شود. passkey بعداً.
   - **وب (same-origin):** کوکی نشست `nevis_session`: `HttpOnly; Secure; SameSite=Strict; Path=/`، مقدار تصادفی ۲۵۶ بیتی، سمت سرور فقط هش آن ذخیره می‌شود؛ عمر لغزنده ۹۰ روز. CSRF: هر درخواست غیر GET باید سربرگ `Nevis-Proto` داشته باشد (سربرگ سفارشی در cross-origin preflight می‌خواهد و سرور CORS ندارد) و `Origin` باید با میزبان یکی باشد. توکن در JS نیست (تهدید XSS؛ R4 §5). کوکی‌های HttpOnly سروری از سقف ۷ روزهٔ ITP معاف‌اند (R2 بند ۳؛ با چک‌لیست M4 تأیید شود).
   - **دسکتاپ و موبایل:** توکن دستگاه (bearer، ۲۵۶ بیت) هنگام ورود صادر می‌شود، در keychain سیستم‌عامل با Rust نگه داشته می‌شود و درخواست‌ها را **Rust** می‌فرستد (ADR-0007)؛ JS توکن را نمی‌بیند. ابطال دستگاه = `device.revoked_at`.
   - rate limit برای ورود (per IP و per حساب) و push (per حساب)؛ از limiter قدیمی.
6. **blob:** `PUT /v1/ws/{ws}/blobs/{sha256}` (سرور هش را بررسی می‌کند؛ آپلود تکه‌ای قابل ادامه از کد قدیمی)، `HEAD` برای وجود، `GET` با `Range`. فایل‌ها در `DATA_DIR/blobs/ab/<sha256>`. GC blob در M9 (کلاینت مجموعهٔ ارجاع را می‌فرستد؛ حذف پس از ۳۰ روز مهلت).
7. **سهمیه:** per حساب (bytes ops + blobs)؛ `QUOTA_MB` مثل قدیم.
8. **محدودیت‌ها:** `http.MaxBytesReader` (۴MB برای ops، `MAX_BLOB_MB` برای blob)، timeoutهای سرور، حداکثر ۵۰۰ op در دسته.
9. **بکاپ:** `VACUUM INTO` دوره‌ای به `DATA_DIR/backup/` + کپی blobها (مثل قدیم)؛ Litestream تأیید نشده (R4 §4) و استفاده نمی‌شود.
10. **پیکربندی:** متغیرهای محیطی مثل سرور قدیمی (`DATA_DIR`، `PORT`، `REGISTRATION`، `SESSION_SECRET`، `QUOTA_MB`، `WEB_DIR`). TLS با reverse proxy.
11. **API:** همه زیر `/v1/`؛ JSON؛ خطا با قالب ADR-0005. `GET /v1/health`.

## پیامدها
- سرور قدیمی مرجع کپی است؛ پکیج‌های `auth`، `apierr`، `config`، `hub`، `storage` (blob) کپی و تطبیق، `vaults` بازنشسته.
- یک نویسنده یعنی سقف توان نوشتن؛ برای سرور شخصی (چند کاربر) بیش از کافی. اندازه‌گیری M4: ≥ ۲۰۰۰ op/ثانیه روی لپ‌تاپ.

## چه چیزی تصمیم را برمی‌گرداند
- آزمون هم‌زمانی گپ‌دار یا از دست رفتن نوشتن با modernc → درایور cgo.
- اگر روزی چند instance لازم شد → جدا کردن لاگ per workspace؛ خارج از دامنه.
