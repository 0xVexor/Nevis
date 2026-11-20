# وضعیت

آخرین به‌روزرسانی: 2026-11-21، پایان M4.

| بخش | وضعیت | امتحان کنید |
|---|---|---|
| 00 راه‌اندازی ریپو و فرایند | انجام شد | این اسناد |
| 01 تحقیق | انجام شد | `docs/research/R1..R7` |
| 02 تصمیم و برنامه | انجام شد | `docs/DECISIONS.md`، `docs/adr/`، `docs/ROADMAP.md` |
| M1 spike ادیتور | کد و آزمون خودکار سبز (`m1`)؛ چک‌لیست iPhone/Safari با مالک | `docs/reports/03-m1-editor-spike.md`، `docs/checklists/M1.md` |
| M2 هستهٔ لاگ + سرور Go + harness | انجام شد (`m2`) | `docs/reports/04-m2-log-core.md`؛ `corepack pnpm converge` |
| M3 IndexedDB + leader چندتب + crash | خودکار سبز (`m3`)؛ iPhone و آزمون ۷ روزه با مالک | `docs/reports/05-m3-idb-leader-crash.md`، `docs/checklists/M3.md` |
| M4 سرور واقعی + ورود وب | خودکار سبز (`m4`)؛ چک‌لیست iPhone/Safari با مالک | `server/scripts/demo.sh` → http://localhost:8788؛ `docs/reports/06-m4-server.md`، `docs/checklists/M4.md` |
| M5 … M16 | در انتظار | `docs/ROADMAP.md` |

## کار مالک الان
- چک‌لیست‌های `docs/checklists/M1.md`، `M3.md`، `M4.md` روی Safari macOS و iPhone (HTTPS: `docs/dev-https.md`).
- `docs/OPEN-QUESTIONS.md` (به‌ویژه ۱: سینک پس‌زمینه، ۲: E2EE، ۸: نام پیش از M6).
- معمار: اصلاح ADR-0003 بند ۱۳ (سقف hold ۱۰ ثانیه) و ADR-0001 بند ۶ (`persist()` نباید await شود).

## منبع قدیمی (مرجع)
ریپوی قدیمی: `/Users/wrangler/Developer/Projects/Nevis`، شاخهٔ `feature/web`.
