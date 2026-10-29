# Nevis — برنامه اجرایی کامل پیاده‌سازی Google Drive Sync

**نوع:** دستورکار اجرایی end-to-end برای سپردن به AI برنامه‌نویس در **یک سشن پیوسته**<br>
**نسخه:** 1.0 | **تاریخ:** 2026-10-28 | **وضعیت:** مشخصات هدف، نه ادعای پیاده‌سازی<br>
**محیط هدف:** Nevis Desktop، Tauri/Rust + React/Tiptap، Windows/macOS، یک مالک با چند دستگاه شخصی<br>
**مبنای اطلاعات فعلی:** `sync-architecture.md`، وضعیت مستند شاخه `sync/github-personal-vaults`<br>
**تصمیم:** Google Drive فضای ابری شخصی کاربر، بدون Sync Server اختصاصی؛ موتور Sync، Merge، History، Recovery متعلق به Nevis است.

> **مهم:** این سند عمداً از «RFC تصمیم‌گیری» به **کارنامه اجرای اجباری با معیار پایان** تبدیل شده است. AI باید از Audit تا تست و اتصال محصول را در **همین سشن** پیش ببرد. صرفاً طراحی، ساخت Prototype جداگانه، نوشتن TODO یا توصیه برای کار آینده، تحویل محسوب نمی‌شود. بااین‌حال ساخت Google Cloud Project و رضایت OAuth یا آزمون حقیقی روی دستگاهی که در دسترس نیست، قابل جعل یا دورزدن نیست؛ کد باید کامل شود و وابستگی بیرونی دقیق گزارش شود.

---

# بخش A — دستور اصلی AI: این قسمت را بدون تغییر به AI بده

## A1. نقش و مأموریت

تو Principal Engineer و مسئول پیاده‌سازی Nevis هستی. باید **Google Drive Sync V1 را مستقیماً در مخزن موجود Nevis به‌صورت production-oriented پیاده‌سازی کنی**. پیش از ویرایش، کد واقعی را مطالعه کن؛ سپس بدون توقف برای گرفتن تأییدهای معمول، طراحی قطعی این سند را اجرا کن، آزمون بنویس، آزمون‌ها را اجرا کن، باگ‌ها را برطرف کن، و در پایان یک گزارش دقیق از کار انجام‌شده ارائه بده. هدف، یک تجربه Local-First چنددستگاهی، بدون سرور اختصاصی، با انتقال incremental، مدیریت تعارض و تاریخچه مستقل است.

**سیاست کار در یک سشن:**

1. در ابتدای سشن راهنمای مخزن/AGENTS.md، وضعیت Git، ابزارهای build و سندهای فعلی را بخوان. از روی مسیرهای پیشنهادی بدون بررسی وجودشان فرض نکن.
2. یک چک‌لیست اجرایی در `docs/sync/drive/IMPLEMENTATION_PROGRESS.md` بساز و در طول کار به‌روز کن؛ فازها را پشت سر هم اجرا کن، صرفاً یک فاز Audit یا Prototype را تحویل نده.
3. هرجا جزئیات مبهم‌اند، مطابق **قوانین پیش‌فرض این سند** تصمیم بگیر و در `DECISIONS.md` ثبت کن؛ برای تصمیم‌های عادی از کاربر سؤال نپرس.
4. قابلیت درست موجود را استفاده مجدد کن؛ برای «تمیزتر کردن کد» بخش‌های نامرتبط را بازنویسی نکن.
5. پس از هر فاز تست‌های مرتبط و سپس lint/typecheck/build را اجرا کن؛ خطاها را تا جایی که دسترسی و ابزار اجازه می‌دهند رفع کن.
6. هیچ داده محلی را پاک، هیچ Repo واقعی کاربر را reset، و هیچ عملیات destructive یا migration غیرقابل‌برگشت را خودکار اجرا نکن.
7. **موفقیت را جعل نکن:** تست شبیه‌ساز جایگزین آزمون واقعی Google OAuth/Drive نیست. اگر کلید OAuth، دسترسی Drive یا دستگاه دوم در محیط موجود نیست، تمام بخش‌های قابل‌پیاده‌سازی را کامل کن، تست‌های Mock/Fault را اجرا کن و مانع بیرونی را با دستور تست دستی مشخص گزارش بده.
8. GitHub Sync موجود را پشت feature flag حفظ کن تا Drive واقعاً آماده باشد؛ **نباید GitHub و Drive هم‌زمان برای یک Vault به‌عنوان دو مرجع نوشتن فعال باشند.**
9. پایان سشن فقط وقتی است که پیاده‌سازی، مستندات، تست‌های قابل‌اجرا و گزارش وضعیت کامل ارائه شده باشند؛ هیچ «در سشن بعدی» یا «بعداً انجام می‌دهم» بدون ذکر علت خارجی قابل‌قبول نیست.

## A2. تعریف موفقیت (Definition of Done)

**تحویل قابل‌قبول باید همگی موارد زیر را داشته باشد:**

- ورود Google با OAuth Desktop + PKCE + OS Credential Store و قابلیت Disconnect/Reconnect.
- اتصال/ایجاد فضای Google Drive متعلق به کاربر و انتخاب Vault، بدون سرور Nevis.
- Sync Engine مستقل از Provider با outbox/inbox پایدار و cursor/recovery؛ ذخیره محلی آفلاین بدون وابستگی شبکه.
- تغییرات افزایشی در سطح بلاک/فیلد/رکورد وقتی امن است؛ fallback محافظه‌کارانه برای موارد پیچیده؛ پیوست content-addressed.
- بسته‌های immutable هر دستگاه با انتشار idempotent و بدون بازنویسی HEAD مشترک؛ دو دستگاه هم‌زمان بدون lost update.
- Merge همگرای قطعی و conflict archive پایدار؛ رفتار حذف/ویرایش آفلاین مطابق سیاست Nevis.
- Checkpoint مستقل، راه‌اندازی دستگاه تازه، remote history حداقلی، و GC محافظه‌کارانه‌ای که هرگز داده لازم را بی‌اثبات حذف نکند.
- اتصال واقعی به UI و وضعیت‌های دقیق Saved Locally / Pending / Syncing / Synced / Conflicts / Paused / Error.
- پیکربندی Auto Sync و Sync Now، retry/backoff، مدیریت quota و خطای OAuth.
- فایل‌های تست، تست‌های خطا و چنددستگاهی شبیه‌سازی‌شده، ابزارهای توسعه برای مشاهده وضعیت و benchmark.
- راهنمای تنظیم Google Cloud/OAuth، راهنمای تست دستی Windows/macOS، گزارش فازها، ریسک‌ها و وضعیت صادقانه تست‌های اجرا نشده.
- **هیچ TODO حیاتی، stub خاموش، swallow error یا مسیر data-loss ناشناخته در مسیر اصلی Sync باقی نماند.** بخش بیرونی غیرقابل‌تست با feature flag و گزارش صریح محدود بماند.

## A3. چیزهایی که مجاز نیست

- نوشتن یک فایل `vault.json` مشترک در Drive و overwrite آن توسط چند دستگاه.
- استفاده از `modifiedTime`، آخرین رسیدن HTTP یا ساعت دستگاه برای انتخاب برنده تعارض.
- `last-write-wins` بدون نگهداری نسخه بازنده.
- پاک کردن دسته‌ای batchهای قدیمی بر اساس سن فایل یا «ظاهراً همه آنلاین شده‌اند».
- تغییر محتوا در مرورگر/ادیتور بدون حفظ ویرایش ثبت‌نشده/selection/undo طبق قرارداد موجود.
- قرار دادن refresh token در JSON آشکار، log، UI، crash report یا فایل Backup.
- دریافت Scope کامل Drive مگر بعد از اثبات شکست طراحی `drive.file` و ثبت تصمیم امنیتی؛ در V1 از Scope گسترده استفاده نکن.
- تبدیل همه keystrokeها به فایل جدید؛ استفاده از یک فایل Drive برای هر بلاک؛ فرض اینکه Drive فقط بایت تغییرکرده را در یک فایل PATCH می‌کند.
- حذف بی‌درنگ فایل‌های موجود در Vault/Drive پس از 404، حذف مجوز یا خراب‌شدن Manifest.
- ادعای pass شدن تست یک OS دیگر، OAuth Production یا حساب واقعی بدون اجرای واقعی.
- ساخت زیرساخت سرور، ایجاد سرویس اشتراکی چندکاربره، CRDT کاراکتری یا E2EE نمایشی/ناقص.

---

# بخش B — تصمیم‌های قفل‌شده محصول و معماری

## B1. نیازمندی محصول

| ویژگی | تصمیم قطعی V1 |
|---|---|
| محل مرجع هنگام کار | Vault محلی؛ Desktop Files + JSON؛ SQLite محلی فقط index در موارد مستند |
| Provider پیش‌فرض جدید | Google Drive شخصی کاربر |
| سرور اختصاصی | ندارد |
| کاربران | یک مالک برای هر Vault؛ چند دستگاه شخصی، نه Collaboration چندنفره |
| سکوی V1 | Windows و macOS دسکتاپ؛ browser-only خارج از دامنه این اجرا |
| وابستگی به اینترنت | فقط Sync؛ Save محلی مستقل است |
| هزینه مستقیم ذخیره | از سهمیه حساب Google کاربر؛ مصرف API پروژه باید مانیتور شود |
| privacy | فایل‌ها در فضای کاربر؛ E2EE در V1 **وجود ندارد و نباید ادعا شود** |
| Delta | عملیات تغییر بلاک/metadata/record + fallback به full item، نه byte-diff دلخواه |
| History | Local History موجود + Remote immutable checkpoints/history با سیاست این سند |
| provider migration | از GitHub فقط با backup و انتخاب صریح کاربر؛ هیچ حذف خودکار GitHub |
| پشتیبان‌گیری | Export/Import قابل‌انتقال فعلی همچنان مستقل باقی بماند |
| اجرا | AI در یک سشن همه مراحل قابل‌اجرا را به‌طور پیوسته انجام دهد |

## B2. اهداف عملکردی اولیه (قابل‌تنظیم، نه SLA)

| پارامتر | پیش‌فرض V1 |
|---|---|
| debounce ادیتور به Repository | وضعیت فعلی، حدود 400ms؛ بدون ریسک ازدست‌رفتن نوشتن |
| زمان سکون برای ساخت batch | 45 ثانیه |
| حداقل فاصله دو انتشار خودکار | 90 ثانیه، به‌جز رفتن برنامه به پس‌زمینه/Sync Now |
| حداکثر انتظار در ویرایش پیوسته | 5 دقیقه |
| تغییرات Remote | هنگام شروع/focus/resume/برگشت شبکه و poll هر 60 ثانیه با jitter |
| بستن طبیعی | تلاش best-effort برای flush/publish؛ **تضمین فقط برای local save** |
| سقف اولیه عملیات در یک batch | 200 operation یا حدود 512KiB payload قبل از فشرده‌سازی؛ قابل شکستن بدون شکستن وابستگی |
| asset بزرگ | streaming و resumable upload، بدون نگهداری تمام فایل در RAM |
| Checkpoint | پس از حداقل 24 ساعت و/یا 1000 batch از checkpoint اخیر، با debounce و بودجه منابع |
| Remote retention | سیاست 30 daily + 12 weekly برای checkpoint؛ حذف raw history فقط با اثبات پوشش/rollback |
| خطای rate limit | Backoff با full jitter و احترام به `Retry-After`/quota؛ Sync Now نباید محدودیت اجباری را دور بزند |

**استثنای مهم:** «ارسال بعد از 45 ثانیه سکون» در عمل نباید local save را عقب بیندازد. زمان‌بندی remote-only است. برای جلوگیری از انفجار تعداد فایل‌ها، batching/coalescing باید واقعی باشد.

## B3. قواعد محصولی حفظ‌شده از تصمیم‌های قبلی

- اگر صفحه روی یک دستگاه حذف و در دستگاه دیگر به‌صورت آفلاین ویرایش شده باشد، **ویرایش آفلاین باعث بازیابی (resurrection) صفحه می‌شود**؛ حذف و نسخه قبلی در Archive/History محفوظ می‌مانند.
- دستگاه تازه باید **تمام صفحات و تمام پیوست‌ها** را دریافت کند (نه فقط lazy placeholder)، مگر خطای واضح/قابل Retry وجود داشته باشد.
- تنظیمات ظاهری مانند Theme و Font Size باید برای هر تنظیم دارای سیاست `global` یا `device-local` باشند؛ حالت دستگاهی به Drive آپلود نمی‌شود.
- تعارض مستقل به‌صورت خودکار merge می‌شود؛ تعارض نامطمئن archive می‌شود و UI امکان حل آن را می‌دهد؛ Merge نباید با انتخاب تصادفی نسخه‌ای را حذف کند.
- همکاری هم‌زمان چند کاربر و Shared Workspace در نسخه اول نیست.

---

# بخش C — نقشه وضعیت فعلی و مرزهای تغییر

## C1. نقطه شروع و مسیرهای موجود (طبق سند، قبل از کدنویسی راستی‌آزمایی شوند)

- `spike/tiptap/src/PageView.tsx`: Tiptap، debounce، ویرایش داخلی و incoming refresh.
- `spike/tiptap/src/repo.ts`: صف write محلی، flush و رفتار external update.
- `spike/tiptap/src/db.ts`: IPC Native / IndexedDB.
- `spike/tiptap/src-tauri/src/main.rs`: commandها، sync worker، timer، وضعیت.
- `spike/tiptap/src-tauri/src/vault.rs`, `registry.rs`: Vault و مسیر/هویت.
- `spike/tiptap/src-tauri/src/sync/snapshot.rs`: snapshot، hash، tombstone، merge قبلی، apply journal.
- `spike/tiptap/src-tauri/src/sync/provider.rs`: پروتکل GitHub، checkpoint/pending.
- `spike/tiptap/src-tauri/src/sync/github.rs`, `network.rs`: GitHub REST/Auth.
- `spike/tiptap/src-tauri/src/sync/mod.rs`, `hub.rs`, `account.rs`: مسیر Legacy.
- `spike/tiptap/src-tauri/src/database/`: 13 نوع record و journals.
- `spike/tiptap/src/GitHubSync.tsx`, `ConflictReview.tsx`, `ConflictDocument.tsx`: اتصال و conflict.

مفاهیم موجود: `write_atomic`، hash SHA-256، backup v2، `pending.json`، `snapshot-apply.json`، tombstone، credential store، `saveForSync`، `vault-changed`، `Kick::Edit`، `Kick::User` و `SYNC:local_changed`/`recovery_required`.

## C2. قواعد استفاده مجدد

| جزء | اقدام |
|---|---|
| Local Vault format، ID صفحات و Assetهای SHA-256 | حفظ؛ تغییر schema فقط با migration نسخه‌دار |
| Atomic write / batch journal / snapshot apply | حفظ/گسترش برای inbox/outbox/frontier |
| Backup v2 / Restore و Hash validation | حفظ؛ Integration تست اضافه شود |
| Conflict archives و UI | حفظ و توسعه بدون از بین رفتن نسخه‌های خام |
| GitHub Provider و branch logic | حفظ پشت flag؛ به‌عنوان هسته Drive استفاده نشود |
| Legacy server | دست‌نخورده مگر برای رفع تداخل build/routing |
| snapshot 95MiB / 512MiB RAM limit | مربوط به GitHub/پیاده‌سازی موجود است؛ **نباید** کورکورانه به Drive منتقل شود |
| JS/Tiptap storage refresh | قبل از apply Remote، unsaved edits flush/archive شوند |
| دو sync engine ناسازگار | یک Coordinator/Domain Contract روشن؛ Providerها می‌توانند قابلیت‌های متفاوت داشته باشند، نه ادعای adapter یکسان بدون test |

## C3. تغییرات معماری پیشنهادی در کد (نام نهایی پس از مشاهده مخزن)

```text
src-tauri/src/sync/
  core/                    # engine/queue/replay/frontier/merge contracts
    mod.rs
    model.rs
    journal.rs
    coordinator.rs
    changes.rs
    merge_page.rs
    merge_database.rs
    checkpoint.rs
    recovery.rs
    errors.rs
  providers/
    drive.rs              # Google Drive transport/metadata/uploads/changes
    drive_auth.rs         # OAuth PKCE + secure token management
  github.rs               # existing, protected by feature flag
```

این درخت **راهنمای منطقی** است؛ AI باید بر اساس ساختار واقعی Rust پروژه جانمایی کند، نه اینکه ماژول‌های موازی بی‌مصرف بسازد.

---

# بخش D — پروتکل ذخیره‌سازی Google Drive: قرارداد عملیاتی

## D1. دامنه و سطح دسترسی

1. Scope پیش‌فرض `https://www.googleapis.com/auth/drive.file`؛ OAuth app از نوع Desktop و از همان Google Cloud project/app identity در Windows و macOS استفاده کند. همواره cross-device file discovery را با حساب تست واقعی بررسی کند.
2. Workspace داده در پوشه قابل‌مشاهده `Nevis` در **My Drive کاربر** باشد؛ از `appDataFolder` به‌عنوان تنها نسخه اطمینان‌بخش داده استفاده نکن.
3. فایل‌های Drive با **file ID** شناسایی شوند؛ نام/مسیر تنها نمایشی و برای discovery است. پوشه‌های هم‌نام ممکن‌اند؛ هرگز با نام تنها join نکن.
4. root/vault/stream/checkpoint folders به `appProperties` استاندارد و `vaultId` مجهز شوند؛ محدودیت اندازه/تعداد property رعایت شود.
5. اگر پوشه ریشه یا شناسه‌ها از دسترس خارج شدند، sync به حالت `REMOTE_UNAVAILABLE/REPAIR_REQUIRED` برود؛ هیچ Vault خالی جدیدی روی قبلی overwrite نشود.
6. bind محلی شامل Google account subject، Google Drive root ID، vault ID، credential profile و protocol version است؛ فقط OAuth identity کافی نیست.

## D2. ساختار منطقی هدف

```text
My Drive/
  Nevis/                                # named folder; actual identity = Drive folder ID
    .nevis-root.json                    # protocol version / owner binding / root GUID
    vaults/
      <vault-id>/
        vault.json                      # immutable bootstrap descriptor; update via new metadata marker, not shared LWW
        streams/
          <device-id>/
            <seq>-<batch-id>.batch      # immutable logical delta batch
        objects/
          <first-2-sha>/
            <sha256>.blob               # immutable content addressed assets
        checkpoints/
          <checkpoint-id>.manifest      # publication marker LAST
          <checkpoint-id>/...           # immutable inventory/object chunks
        decisions/
          <resolution-id>.batch         # conflict resolution as durable operation
```

**این ساختار منطقی است:** در Drive باید folder IDs و parent IDs در metadata index محلی cache شوند؛ ساختن هزاران folder برای هر ریزعملیات مجاز نیست. `changes` feed جهانی حساب، ابتدا بر اساس file ID + ancestry/appProperties به Vault مربوط فیلتر می‌شود.

## D3. فایل‌ها و schemaهای نسخه‌دار

**Envelope مشترک** برای هر سند جدید:

```json
{
  "protocol": "nevis-drive-sync",
  "schemaVersion": 1,
  "vaultId": "uuid",
  "kind": "change-batch | checkpoint | object-manifest",
  "payloadSha256": "hex",
  "contentEncoding": "canonical-json+gzip",
  "createdByDeviceId": "uuid"
}
```

**Change Batch — فرمت مرجع پیشنهادی:**

```json
{
  "schemaVersion": 1,
  "vaultId": "uuid",
  "deviceId": "uuid",
  "sequence": 42,
  "batchId": "sha256-of-canonical-payload-with-stable-header",
  "previousBatchId": "batch-41-or-null",
  "seenFrontier": {"device-A": 41, "device-B": 12},
  "operations": [
    {
      "opId": "device-A:42:1",
      "kind": "page.block.set",
      "target": {"pageId": "page-1", "blockId": "block-7"},
      "baseHash": "sha-of-old-block",
      "baseValue": {"type": "paragraph", "content": []},
      "newValue": {"type": "paragraph", "content": [{"type":"text","text":"new"}]}
    }
  ],
  "requiredObjects": ["sha256:..."],
  "integrity": {"algorithm": "sha256", "payloadHash": "hex"}
}
```

فرمول canonical `batchId` باید **بدون hash-self-reference** تعریف شود: ابتدا stable header بدون `batchId` و بدون `integrity.payloadHash` canonicalize، سپس SHA-256 محاسبه و هر دو مقدار درج شوند. encoding بایت‌ها و decoding حجم/ratio باید با test fixture قفل شود. `createdAt` برای نمایش/diagnostic مجاز است، نه ترتیب causal.

### D3.1 انواع Operation نسخه اول

- `page.create`, `page.delete`, `page.restore`، `page.metadata.set`، `page.block.insert`, `page.block.set`, `page.block.move`, `page.block.remove`، `page.replace-safe` برای fallback کنترل‌شده.
- `db.record.create`, `db.record.set-field`, `db.record.delete`, `db.record.replace-safe`؛ هویت record ثابت.
- `kv.set`, `kv.remove`, `kv.set-member.add/remove` فقط برای keyهای allowlisted.
- `asset.reference.add/remove` و `asset.object-available` (وجود فیزیکی asset قبل از batch بررسی شود).
- `conflict.resolve`، `conflict.archive`، `settings.sync-policy.set` در صورت نیاز با schema ثابت.

**قانون مهم:** برای operationهایی که بدون base کافی در وضعیت دیگری اجرا نمی‌شوند، `baseValue` یا یک preimage بازیابی‌پذیر داخل payload قرار گیرد. فقط `baseHash` بدون قابلیت خواندن نسخه پایه برای ادغام آفلاین بعد از compaction کافی نیست. اندازه payload و محرمانگی preimage باید اندازه‌گیری شود.

## D4. ثبت تغییر محلی و batching

1. در commit شدن write محلی، در همان محدوده سازگاری crash-recovery یک نشانگر dirty/version ثبت کن (نه بعد از HTTP).
2. در زمان batch، snapshot سازگار از داده/dirty range بگیر. تغییرات را نسبت به **آخرین local capture/published baseline معتبر** diff کن، نه صرفاً رویداد UI. تغییرات ناشی از remote apply نباید دوباره به‌عنوان local edit منتشر شوند.
3. با stable IDs درخت Tiptap، عملیات کوچک بساز. اگر پیچیدگی ساختاری یا base نامعتبر بود، `page.replace-safe` با base/preimage کامل بساز؛ اجازه silent overwrite ندارد.
4. تغییرات متعدد همان property/block در یک پنجره جمع شوند، اما حذف+بازسازی، move و ordering و preconditions نابود نشوند.
5. قبل از صف کردن publish، bytes canonical، dependency list، sequence، previous batch hash و outbox receipt را durable کن.
6. اگر پنجره انتشار بسته شد ولی dirty نبود، **هیچ فایل جدیدی در Drive ساخته نشود**.
7. batchها می‌توانند چند صفحه/رکورد را شامل شوند؛ سقف size و ops تنها در مرزهای اتمیکِ منطقی شکسته می‌شود.
8. اگر داده در هنگام HTTP تغییر کند، outbox قبلی immutable باقی بماند و تغییر جدید در batch بعدی قرار گیرد.

## D5. Atomic publication منطقی (نه اتمیک چندفایلی Drive)

```text
Local durable edits
  → Capture consistent dirty range
  → Freeze immutable outbox batch & sequence
  → Upload missing content-addressed objects (verify bytes/hash)
  → Upload immutable batch FINAL (publication marker)
  → Query/verify exact remote file ID and payload integrity
  → Persist remote ack of that batch
  → Advance safe local publish frontier only for acknowledged batch
```

- `files.generateIds` را **در صورت سازگاری واقعی با نوع فایل/endpoint** برای idempotent create استفاده کن؛ ID پیش‌ساخته را پیش از ارسال روی دیسک ذخیره کن. برای عدم قطعیت response، با `files.get(fileId)` و hash/size validate کن؛ 404 کوتاه‌مدت نباید باعث ساخت بی‌رویه duplicate شود.
- اگر ID preallocation برای حالت خاصی کار نمی‌کند، از `batchId` + `appProperties` + reconcile امن با list/get و پاک‌نکردن pending استفاده کن؛ uniqueness صرفاً با نام فایل تضمین نمی‌شود.
- در صورت ناکامل بودن objectهای پیش‌نیاز، reader بسته را **defer** کند، نه اینکه بخشی از آن را اعمال کند.
- Drive upload موفق اما response نامعلوم: Pending را باز نگه دار، بررسی کن، دوباره upload کورکورانه نکن.
- دستگاه‌های A و B روی streamهای جدا با immutable files می‌نویسند؛ هیچ `latest.json` مشترکی overwrite نمی‌شود.
- validation لازم: schema، vault ID، device ID، sequence، prev hash، payload hash، size، compression bomb، path traversal، appProperties mismatch.

## D6. کشف اولیه، Sync دوره‌ای و cursor

**Bootstrap بدون race:**

```text
startToken = changes.getStartPageToken()
Persist bootstrap-in-progress and startToken
Full recursive/paginated listing of files under verified root ID
Validate metadata, record discovered immutable files into durable inbox/index
Fetch changes.list(startToken) through all pages; merge discovered file IDs
Only then persist newStartPageToken and mark inventory complete
```

**عملکرد عادی:**

- از `changes.list(pageToken)` استفاده کن؛ تمام `nextPageToken`ها را بخوان؛ `newStartPageToken` را فقط بعد از ثبت durable همه discovered file IDs نگه دار.
- `removed` در Change API می‌تواند تغییر دسترسی/حذف فایل باشد؛ **این رویداد معادل حذف یادداشت Nevis نیست**.
- Cursor منقضی یا invalid: full inventory scan دوباره، بدون پاک‌کردن داده محلی یا فرض remote empty.
- اگر تغییر file metadata اشتباه/تکراری رسید، ingest براساس immutable file ID و batchId idempotent باشد.
- `changes.list` به‌تنهایی جای full inventory recovery نیست؛ در restart، stale device و storage corruption گزینه rescan بگذار.
- از `fields` محدود، pagination، cache folder IDs و ممانعت از `files.list` سراسری در هر poll استفاده کن.

## D7. رویداد و ترتیب علی (causal ordering)

- هر device یک monotonic `sequence` با state durable و `previousBatchId` دارد.
- `seenFrontier` نشان می‌دهد در زمان ایجاد batch کدام عملیات دیگران دیده/اعمال شده بود؛ اگر dependency ناقص است، inbox در `WAITING_DEPENDENCY` بماند.
- از `(deviceId,sequence)` برای dedup و کشف gap استفاده کن؛ از `batchId` برای تأیید یکسان بودن محتوای یک seq.
- اگر دو payload متفاوت با deviceId/seq یکسان دیدی، `DEVICE_ID_COLLISION/INTEGRITY`؛ هیچ‌کدام را بی‌صدا انتخاب نکن.
- `appliedFrontier` و `outbox published frontier` متفاوت‌اند؛ جلو بردن cursor دریافت برابر با apply نیست.
- تمام داده خوانده‌شده از Drive ورودی untrusted است؛ validate و محدودسازی منابع الزامی است.

---
# بخش E — Merge دقیق؛ مهم‌ترین بخش پیاده‌سازی

## E1. اصل همگرایی و حل تعارض

برای یک مجموعه ثابت از batchها، **همه دستگاه‌ها صرف‌نظر از ترتیب دریافت باید یک canonical state یکسان و conflict set یکسان داشته باشند**. الگوریتم نمی‌تواند از «نسخه Local خودم» برای انتخاب برنده نهایی استفاده کند؛ «Local» فقط برچسب نمایشی در UI است. اگر دو تغییر concurrent ناسازگار هستند، هر دو candidate کامل در archive محفوظ می‌مانند و `conflictId` از شناسه آبجکت، شناسه فیلد/بلاک، شناسه base و شناسه‌های مرتب‌شده عملیات متعارض به‌صورت deterministic ساخته می‌شود.

**الگوریتم:**

1. برای هر تغییر، base/preimage معتبر و causal dependencies را پیدا کن.
2. اگر عملیات‌ها causally ordered هستند، به همان ترتیب منطقی اعمال شوند؛ remote older ممکن است زیر نسخه جدیدتر باشد و نباید آن را بازگرداند.
3. برای تغییرات concurrent روی objectهای/فیلدهای مستقل، در یک ترکیب canonical merge کن.
4. اگر operationها روی یک target برخورد دارند و نتیجه امن و یکتا وجود ندارد، `ConflictRecord` قطعی بساز؛ هر دو نسخه و preimage باقی بمانند.
5. جهت نمایش UI یکی از candidateها را طبق ordering ثابت بر اساس `(deviceId, sequence, opId)` به‌صورت **temporary visible winner** انتخاب کن، ولی نسخه دیگر همیشه در conflict archive و Restore در دسترس است. این انتخاب به معنی resolved بودن نیست.
6. `conflict.resolve` یک operation جدید با `resolvedConflictId` و `resolutionBase` است؛ اگر دو دستگاه یک conflict را به دو شیوه حل کردند، دوباره Conflict ثانویه ساخته می‌شود؛ حذف بی‌صدای یکی مجاز نیست.
7. قبل از اعمال هر merged result تمام invariantهای صفحه/DB/attachments را اعتبارسنجی کن؛ نتیجه نامعتبر در quarantine بماند، نه اینکه فایل ناقص نوشته شود.

**ممنوع:** Merge با «هر دستگاه آخرین چیزی که دیده برنده است»، استفاده از timestamp برای resolution، یا ثبت conflict با UUID تصادفی متفاوت روی دو دستگاه به‌عنوان تنها شناسه منطقی.

## E2. Tiptap: شناسه بلاک و ساختار چندستونه

**پیش‌نیاز:** Audit schema واقعی Tiptap. تمام nodeهایی که واحد Sync مستقل هستند باید `stableBlockId` داشته باشند. جدول، ستون، row، item فهرست، task و layout container نیز برحسب قابلیت و schema واقعی باید stable identity داشته باشند. Nodeهای purely inline ممکن است نیازی به ID مستقل نداشته باشند.

- **داده قدیمی بدون ID:** قبل از sync نخست، backup و یک migration **deterministic در همان snapshot base** بساز؛ شناسه‌ها از `pageId + canonical structural path + stable occurrence index` و namespace نسخه‌دار به‌شکل پایدار استخراج شوند تا دو دستگاه با base یکسان، ID یکسان بسازند. اگر baseها فرق دارند، migration concurrent را conflict کن؛ silently random ID نساز.
- **بلاک جدید:** UUID/ULID تصادفی با collision check. در copy/paste و duplicate، شناسه جدید؛ در undo/redo همان identity منطقی، نه duplicate.
- **متن یک بلاک:** در V1 محتوای Rich Text همان بلاک یک واحد است؛ هم‌زمان دو ویرایش ناسازگار متن داخل یک بلاک conflict است، نه merge حروفی ادعایی.
- **ویژگی‌های مستقل:** مثلاً title صفحه و paragraph مستقل merge می‌شوند. attributeهای همان بلاک فقط وقتی keyهای جدا با base معتبر هستند merge fieldwise.
- **ساختار ستون:** `insert`, `move`, `remove` بر مبنای parent stable ID و ordering position تعریف شود؛ position token/order key مستقل از index متغیر؛ به conflictهای concurrent حرکت پاسخ deterministic بده.
- **دو insert concurrent در یک موقعیت:** ترتیب پایدار از position token + op ID؛ هیچ insert حذف نشود.
- **move+edit یک بلاک:** اگر دو عملیات مستقل و شیء باقی است، حرکت و محتوا جمع شوند.
- **move+move concurrent به دو parent:** conflict؛ یک موقعیت نمایشی deterministic، هر دو parent candidate در archive.
- **delete+edit همان بلاک:** archive، طبق سیاست سطح page، recover/edit visible در شرایط تعریف‌شده؛ referenceهای لازم حفظ شوند.
- **حذف والد و افزودن فرزند:** orphan به‌صورت خام رها نشود؛ attachment/child در recovered/conflict container معتبر حفظ شود.
- **schema نامعتبر/unknown node/plugin:** بدون drop کردن fieldهای ناشناخته، archive و توقف apply آن object؛ اگر امکان preserve opaque node هست، بدون render-edit-loss انتقال یابد.
- **selection / undo / focus:** تغییر شبکه‌ای قبل از render با saveForSync/flush یا archive ویرایش معلق، سپس invalidate مربوط؛ تغییر بی‌معنا مثل reorder کلید JSON نباید editor را reset کند.

**تست ثابت ضروری:** 10,000 permutation ترکیب عملیات روی دو/سه دستگاه با generator seeded؛ `canonical_page_hash` و `conflict_ids` برای همه ترتیب‌ها یکسان. در تست زمان محدود، تعداد کمتر با seed ثبت‌شده قابل اجراست ولی suite بزرگ برای CI موجود باشد.

## E3. Database و روابط

در معماری فعلی 13 نوع record وجود دارد: `container`, `source`, `property`, `view`, `relation`, `edge`, `template`, `workflow`, `comment`, `principal`, `grant`, `event`, `allocator`.

- ID رکورد و relation/edge **باید حفظ شود**؛ create concurrent با ID یکسان و payload ناسازگار خطای identity است.
- فیلد مستقل با base معتبر merge fieldwise؛ دو write ناسازگار همان فیلد archive.
- `allocator` را صرفاً increment عددی فایل مشترک فرض نکن؛ namespace تخصیص ID باید collision-safe (ID تصادفی/ترکیبی) و با semantics فعلی سازگار باشد.
- list/order و edge relation invariants پس از apply validate شوند؛ foreign-key مانند referenceهای برنامه نباید به object مفقود بی‌صدا اشاره کنند.
- batch چندرکوردی که یک عملیات منطقی را تشکیل می‌دهد، **atomic group** با preconditions دارد؛ apply یا کامل یا none. تست crash بین recordها لازم است.
- DB index از منابع مرجع دوباره ساخته می‌شود؛ index یا cache به Drive sync نمی‌شود.
- تعداد تغییرهای زیاد record باید stream شوند؛ جلوگیری از کپی کل DB در حافظه.

## E4. KV، تنظیمات و داده‌های دستگاهی

- allowlist همان معماری فعلی: `settings`, `templates`, `tags`, `srs`, `reviewlog`, `savedSearches`, `tasksInbox`, `preferences`, `workspace` و کلیدهای `db.personal.*` معتبر؛ قبل از اجرا با source verify شود.
- هر key نوع Merge تعریف‌شده داشته باشد: scalar سه‌طرفه، set با add/remove صریح، object فیلدبه‌فیلد، یا opaque conflict.
- Cache صفحه جاری، token، device ID، path محلی، window size اختصاصی، cursor، debugging و secrets never sync.
- تنظیمات نمایش `global` یا `device-local`، تصمیم per-key است. تغییر policy هم operation نسخه‌دار باشد؛ migration policy نباید local value را بی‌صدا پاک کند.

## E5. Deleted vs offline edited (سیاست محصول)

**سناریو:** A صفحه P را حذف می‌کند؛ B در حالت آفلاین P را ویرایش می‌کند.

- هنگام جمع‌شدن عملیات، محتوای ویرایش‌شده P احیا می‌شود (`page.restore/resurrect` با provenance)، *همان page ID* حفظ شود.
- tombstone و نسخه حذف‌شده برای audit/history نگه داشته می‌شوند.
- دستگاهی که عملیات حذف را دیده، بعداً نباید صرفاً به‌خاطر cache خود صفحه را دوباره حذف کند.
- حذف نهایی/پرماننت در UI باید با هشدار درباره باقی‌ماندن نسخه در history/backup و دستگاه‌های آفلاین همراه باشد؛ ادعای پاک‌شدن فیزیکی از همه دستگاه‌ها یا Remote History نکن.
- نبود فایل یا 404 در Drive هرگز به معنی `page.delete` نیست؛ فقط operation معتبر امضاشده/با هویت مورد انتظار (در V1 حداقل integrity/provenance) مجوز حذف منطقی دارد.
- اگر صفحه روی هر دو دستگاه مستقل حذف شد، tombstone یکتا/deduplicated؛ history قابل بازیابی طبق retention.

## E6. Conflict UI: دقیقاً چه چیزی ساخته شود؟

1. بخش `Sync conflicts` با شمارش خطاهای حل‌نشده و دسته‌بندی: متن بلاک، ساختار صفحه، حذف/ویرایش، DB record، setting، integrity.
2. نمایش `base / version A / version B`، دستگاه/زمان صرفاً اطلاع‌رسانی، diff در سطح بلاک/فیلد، بدون HTML roundtrip به داده.
3. عمل‌های `Keep A`, `Keep B`, `Keep both` فقط اگر نوع object اجازه دهد، و `Manual merge` برای متن/محتوای قابل ویرایش (اگر بر پایه UI فعلی ایمن است). در غیر این صورت Manual disabled با توضیح صریح.
4. Resolve با operation پایدار منتشر شود؛ conflict فایل قدیمی بی‌سروصدا حذف نشود. حل conflict پیش از remote publish در local journal ثبت شود.
5. Conflict pending به معنی کل vault sync failure نیست؛ تغییرات مستقل باید بتوانند sync شوند و UI distinction نشان دهد.

---

# بخش F — تاریخچه، Checkpoint، رشد فایل‌ها و GC

## F1. سه لایه مستقل؛ ادعاهای متفاوت

1. **Undo/Local History:** سریع، روی دستگاه و با retention فعلی 40 نسخه صفحه/50 رکورد در وضعیت مستند؛ cloud-independent.
2. **Remote Changes:** بسته‌های immutable موردنیاز برای همگرایی بین دستگاه‌ها؛ history دائمی محصول نیستند.
3. **Remote Checkpoints / History:** تصاویر معتبر قابل Restore از Vault در frontier معین؛ انتخاب نسخه قدیمی از UI بر اساس این تصاویر، نه `Drive revisions`.

در V1 بازگردانی History باید هرگز Vault فعال را مستقیم overwrite نکند؛ ابتدا preview / restore as copy / guarded restore با بکاپ کامل و ID/decision روشن.

## F2. Checkpoint format و روش publication

```json
{
  "schemaVersion": 1,
  "checkpointId": "content-addressed-or-random-with-manifest-hash",
  "vaultId": "uuid",
  "frontier": {"device-A": 142, "device-B": 88},
  "createdByDeviceId": "uuid",
  "inventory": [
    {"path": "pages/page-1.json", "sha256": "...", "objectId": "..."},
    {"path": "files/ab/<sha>", "sha256": "...", "objectId": "..."}
  ],
  "openConflictIds": ["..."],
  "tombstoneDigest": "...",
  "manifestDigest": "sha256-of-normalized-manifest"
}
```

**الزامات:**

- Checkpoint از یک **consistent local snapshot** شامل inventory، DB records، KV مجاز، tombstone و conflict ساخته شود؛ هر object لازم باید به‌صورت streaming به Drive رسیده و hash آن verify شده باشد.
- Checkpoint manifest **آخر** و به شکل immutable منتشر شود. Manifest ناقص معتبر نیست.
- قبل از اعلان usable، یک reader مستقل cold-restore فایل‌ها را در staging و hash/semantic consistency را validate کند (به کمک test harness و در مسیر critical با validator).
- Device دیگر فقط checkpoint با manifest معتبر و required objects قابل دریافت را مصرف می‌کند.
- اگر دو Checkpoint هم‌زمان با frontier غیرقابل‌مقایسه ساخته شدند، هیچ‌کدام با `modifiedTime` انتخاب نشود؛ یا checkpointی با frontier غالب انتخاب کن یا **unionِ checkpoint frontier + uncovered streams** را replay و state را merge کن؛ در نبود اثبات کامل، safe fallback به replay کامل.
- History Snapshots می‌توانند objectهای content-addressed مشترک را reference کنند؛ هنگام گرفتن Checkpoint عکس‌ها هر بار آپلود نشوند.

## F3. دستگاه جدید یا دستگاه ماه‌ها آفلاین

**New device:**

1. Google Sign-in با app identity درست؛ کشف Vault از root index و verified IDs.
2. ایجاد `deviceId` تازه در app-data، **نه کپی Device ID Vault**.
3. گرفتن changes start token؛ full inventory + feed catch-up.
4. انتخاب checkpoint معتبر و reconstruct در stage folder جدید با ID Vault موجود.
5. replay batchهای uncovered با causal ordering و dedup؛ دریافت **تمام assetهای موردنیاز**.
6. verify schema/path/hash/DB invariants؛ rename مرحله staging به محل نهایی؛ ثبت local checkpoint/frontend؛ سپس app Vault را باز کند.
7. **هیچ delete عمومی ناشی از empty staging/create** ارسال نشود.

**Old offline device:**

- اول remote inventory/checkpoint را بگیرد، بعد outbox محلی تغییرات قدیمی خود را با preimage/causal base خودش rebase/merge کند و سپس انتشار جدید بسازد.
- اگر Stream قبلی در checkpoint پوشش داده شده، `sequence` محلی همچنان باید حفظ شود و سطرهای تکراری دوباره published نشوند.
- اگر base کافی در local journal یا operation payload موجود نیست، `REBASE_REQUIRED` و restore-safe mode؛ هرگز remote را با state محلی قدیمی بازنویسی نکن.
- بازگشت بعد از 1 ماه/6 ماه، reinstall، restore backup و clock skew باید تست شود.

## F4. Compaction: الزام دارد، اما داده را بی‌اثبات حذف نکن

فقط گذاشتن میلیون‌ها batch روی Drive برای همیشه پذیرفتنی نیست. پیاده‌سازی **Compaction قابل‌آزمون** الزامی است، ولی destructive pruning تنها تحت شرایط بسیار محدود:

1. تمام batchهای نامزد در `frontier` یک checkpoint **کامل و اعتبارسنجی‌شده** پوشش داده شوند.
2. test harness باید با **فقط فایل‌های باقی‌مانده** بتواند Vault را روی دستگاه خالی بازسازی کند، بدون رجوع به فایل‌های حذف‌شونده.
3. هیچ conflict باز، Undo/History نگهداری‌شده، attachment reference، checkpoint قدیمی قابل Restore یا pending job به آن objectها متکی نباشد.
4. deviceهای قدیمی باید protocol migration/rebootstrap را پشتیبانی کنند. برای offline edits، preimage/operation base حفظ‌شده و آزمون rebase موفق لازم است.
5. قبل از حذف، candidate inventory و proof-of-coverage در local journal ثبت شود. حذف مرحله‌ای و idempotent؛ crash در نیمه GC قابل بازیابی باشد.
6. از Drive Trash/quarantine با پنجره محافظه‌کارانه (مثلاً حداقل 7 روز) پیش از permanent removal استفاده کن؛ **مهم:** Trash در طول quarantine دیگر برای Sync به‌عنوان موجودی عادی قابل فرض نیست؛ پیش از Trash باید restore بدون آن اثبات شده باشد.
7. اگر هر شرط قابل اثبات نیست، GC باید برای همان batch/asset به‌شکل **fail-closed** عمل کند و `GC_DEFERRED(reason)` گزارش بدهد؛ نباید با حدس فایل را حذف کند.
8. مسیرهای `GC dry-run`, `GC verify`, `GC execute guarded`, `GC recovery` همراه تست پیاده شوند. در نسخه اولیه، اجرای destructive GC **فقط بعد از عبور کامل از release gates** فعال شود؛ default اگر اثبات کامل در محیط موجود نیست: dry-run، نه پاک‌کردن واقعی.
9. هزینه تعداد Drive items و storage باید در `Sync Diagnostics` نمایش داده شود؛ اگر GC غیرفعال است، کاربر را با «فضای نامحدود» گمراه نکن.

**نکته نظری:** هیچ الگوریتمی بدون قرارداد rebootstrap و preimage نمی‌تواند هم «هر دستگاه برای همیشه آفلاین بماند»، هم «همه فایل‌های تاریخی دوردست حذف شوند»، هم «هر نوع Merge دقیق بدون base» را تضمین کند. سند این tradeoff را حل‌شده فرض نمی‌کند؛ تحت fail-closed قرار می‌دهد.

## F5. تاریخچه نسخه‌ها و UI

- Local `History` فعلی حفظ؛ در UI بخش Remote Restore Points با timestamp **فقط برای نمایش** و `checkpointId/frontier` برای هویت.
- daily checkpoints: نگهداری 30 روز؛ weekly: 12 هفته؛ عددها config و فقط برای نسخه‌های قابل بازیابی‌اند، نه مجوز حذف همه batchها.
- قبل از restore، Back up current Vault و output checksum؛ create copy اگر انتخاب شد `vaultId` جدید و بدون sync auto.
- Restore در Vault فعال: با اقدام صریح کاربر و operationهای جبرانی/versioned یا rebuild guarded، نه بازنویسی بی‌سروصدای cloud state.
- هر Checkpoint قدیمی که در retention حذف می‌شود، باید referenceهای content-addressed history/asset از GC محسوب شوند.

---

# بخش G — امنیت، هویت، پایداری و Budget

## G1. Google OAuth Desktop

- OAuth authorization-code flow with PKCE با system browser و loopback redirect در Tauri/Rust؛ اپ دسکتاپ public client است، **Client Secret محرمانه داخل build قرار نده**.
- حداقل Scope `drive.file` و `openid`/`email` فقط اگر برای هویت binding واقعاً نیاز است؛ در صورت عدم نیاز Scopeهای اضافی حذف شوند.
- در Windows Credential Manager و macOS Keychain access/refresh token امن ذخیره شوند؛ app preview و release credential service name متفاوت داشته باشند.
- فرایند sign-in، cancel، timeout، access revoked، refresh token invalid، restart midway و switch account قابل Recover باشد.
- در Google Cloud Console نیاز به Desktop OAuth client و فعال کردن Drive API و consent/publishing settings است؛ کد Config Template بساز، **شناسه/کلید ساختگی در سورس commit نکن**.
- وضعیت OAuth Testing ممکن است Refresh Token را محدود کند؛ این یک شرط انتشار واقعی است و باید در Setup Guide ثبت شود.
- Cross-device discovery برای فایل‌های app-created با `drive.file` را با تست live اثبات کن؛ اگر شکست خورد، بدون اجازه به Scope وسیع مهاجرت نکن. راهکار جایگزین با Picker/انتخاب فولدر یا explicit reconnect به‌صورت محدود پیاده/مستند شود؛ مسأله معلق به معنی ادعای Sync کامل نیست.
- اگر Google Account دیگری وصل شد، ریشه قبلی متعلق به حساب جدید فرض نشود؛ rebind تنها پس از بررسی identity و backup.

## G2. Threat model حداقلی

**ورودی‌های غیرقابل‌اعتماد:** فایل Drive، gzip payload، JSON، metadata، file name، checkpoint manifest، SVG/image attachments، unknown plugin schema، external files در Vault.

- اندازه/نسبت فشرده‌سازی، عمق JSON، تعداد nodeها، max allocations، timeout و memory limit اعمال شود.
- ممنوعیت path traversal، symlink، reserved Windows names، case-insensitive collisions، NUL، escaping separator و absolute path.
- Vault ID، root folder ID، device ID و `sha256` را با بایت verify کن؛ hash به‌تنهایی در برابر **تصاحب حساب Google و تغییر هم‌زمان payload/hash** امضای مستقل نیست.
- از API logging با token/filename/content خصوصی پرهیز؛ user-visible diagnostics حداقلی و redacted.
- TLS certificate verification و proxy سیستم؛ timeout جدا برای connect/read/upload.
- private Google Drive به معنی End-to-End Encryption نیست. UI/Docs ادعای zero-knowledge نکنند.
- پس از unlink account، credential حذف شود ولی Vault local پاک نشود و هیچ fallback پنهان به Provider دیگر صورت نگیرد.

## G3. API، خطا و بودجه

**روش کار:** حد واقعی quota و billing را از Console/API docs روز اجرا بخوان؛ عددهای این سند فقط baseline برای طراحی‌اند. از 2026-05-01 مدل Usage Limits برای بعضی پروژه‌ها عوض شده؛ quota بر اساس units/پروژه و units/کاربر است، هزینه احتمالی را صفر تضمین نکن.

- پیاده‌سازی `DriveQuotaMeter`: شمار operation type، requests، quota estimates، bytes upload/download، files.list، changes.list، p50/p95 elapsed، storage estimate، rate-limit events.
- **اصل اقتصادی:** فقط یک `changes.list` دوره‌ای، `fields` محدود، cache metadata، asset dedup، batching و no-op elimination؛ full scan فقط bootstrap/recovery.
- به `403 rateLimitExceeded/userRateLimitExceeded`، `429`، `5xx` با exponential backoff/full jitter و `Retry-After` پاسخ درست بده؛ `403 permissionDenied` را با rate-limit اشتباه نگیر.
- `401 invalid_token`: single refresh attempt with serialized token refresh؛ شکست قطعی → `SIGN_IN_REQUIRED` و حفظ outbox.
- `404` فایل مرتبط: بین permission removal، item deleted، wrong account، missing object و eventual listing delay تمایز بده. هیچ حذف محلی خودکار.
- `409` file collision: read & hash verify؛ اگر متفاوت، integrity incident.
- فضای کاربر پر، oversize/quota، invalid_scope، account suspended، truncated downloads، proxy error و offline باید وضعیت مجزا بگیرند.
- Budget Guard برای خطر هزینه: request rate و full-scan limit قابل‌تنظیم، با محافظت در UI؛ امکان Pause Sync، بدون Pause Local Save.

## G4. State machine و UX

```text
OFF / NOT_CONNECTED
  ↓ connect
CONNECTING → INITIALIZING → IDLE
                ↓ local dirty
             PENDING_LOCAL → SYNCING → IDLE (confirmed remote ack)
                ↓ error
             OFFLINE / RATE_LIMITED / AUTH_REQUIRED / REPAIR_REQUIRED
                ↓ recover
             PENDING_LOCAL (no lost edit)
IDLE or SYNCING → CONFLICTS_PENDING (independent safe updates may continue)
USER PAUSE → PAUSED (local saves still work)
```

**اصول نمایش:**

- `Saved locally`: فقط flush محلی durable تأیید شده.
- `Waiting to sync`: outbox یا dirty محلی منتشرنشده موجود است.
- `Syncing`: عملیات upload/download/apply در جریان.
- `Synced`: در زمان `lastVerifiedAt`، هیچ local dirty/outbox unacked یا apply pending نیست؛ **تضمین اینکه Google Drive در لحظه هیچ تغییر جدیدی ندارد نیست**.
- `Conflicts`: conflict unresolved باقی است حتی اگر batchهای غیرمتعارض قبلاً منتشر شده‌اند.
- `Paused/Offline`: واضح؛ تغییرات محلی امن‌اند ولی روی دستگاه دیگر لزوماً موجود نیستند.
- `Sync Now`: پیش از اجرای worker `saveForSync()` انجام شود؛ completion IPC نباید با پایان Sync یکی گرفته شود؛ UI result event واقعی نمایش دهد.
- `Account settings`: نام سرویس، حساب Google، Vault ID قابل کپی، فضای مصرفی تخمینی، آخرین ارسال/دریافت، Pending، Conflicts، Retry, Reconnect, Disconnect, Export Backup, Diagnostics.
- هم‌زمانی UI: یک عملیات single-flight؛ دکمه Sync Now هنگام Sync فعال فقط trigger بعدی coalesced ایجاد کند.

---
# بخش H — برنامه کار مرحله‌به‌مرحله در همان سشن

> **اصل اجرای فازها:** فازها «نقاط تأیید کاربر» نیستند. AI باید پس از هر گیت سبز به فاز بعدی برود. اگر گیت قرمز است، اول باگ را رفع کند. اگر علت خارجی/محدودیت محیط است، feature مربوط را fail-closed نگه دارد و بقیه کار را ادامه دهد. گزارش نهایی باید دقیقاً نشان بدهد چه چیزی کامل، چه چیزی تست‌نشده و چه چیزی Blocked است.

## فاز 0 — Audit هدفمند واقعی؛ سپس فوراً ادامه پیاده‌سازی

**اقدامات:**

1. `git status`, branch، package scripts، Cargo workspace و دستورهای dev/build/test را پیدا کن؛ تغییرات موجود کاربر را overwrite نکن.
2. سند معماری فعلی را با کد تطبیق بده؛ path و typeهای واقعی، provider routing، registry، saveForSync و editor schema را ثبت کن.
3. تست و ماژول‌های آماده مرتبط را فهرست کن؛ کدام reuse و کدام replace می‌شوند.
4. Audit کن آیا بلاک‌های Tiptap پایدار و قابل merge هستند؛ وضعیت DB record field schema و allocator را بررسی کن.
5. feature flag و محیط Preview/Production را تشخیص بده.
6. `docs/sync/drive/IMPLEMENTATION_PROGRESS.md` و `DECISIONS.md` را با Inventory و Plan پر کن.
7. **بدون توقف وارد فاز 1 شو**؛ نتیجه Audit فقط در گزارش ثبت می‌شود.

**پایان فاز:** dependency map و cross-module interfaces واقعی مشخص؛ build baseline و tests موجود (اگر قابل اجرا) ثبت‌شده.

## فاز 1 — قرارداد domain و تست‌پذیری

**اقدامات:**

1. State Machine و Error taxonomy (`AUTH`, `PERMISSION`, `NETWORK`, `QUOTA`, `INTEGRITY`, `CONFLICT`, `RECOVERY`, `LOCAL_CHANGED`, `MISSING_DEPENDENCY`, `SCHEMA`) را تعریف کن.
2. `SyncStorageAdapter` مستقل با قابلیت‌های immutable object/list/changes/folder metadata بساز؛ آن را در `SnapshotProvider` GitHub بدون شکست ABI موجود جا نزن.
3. Domain types نسخه‌دار `ChangeBatch`, `Operation`, `Frontier`, `Inbox`, `Outbox`, `Checkpoint`, `ConflictRecord`, `DeviceBinding` بساز.
4. JSON canonical/encoding/digest fixtures ایجاد کن و backward/forward schema rejection رفتار تعریف کن.
5. FakeDrive in-memory/disk-backed و Fault Injector با reorder, duplicate, response-lost, 404, 409, 429, delay, partial file و crash points اضافه کن.
6. invariant assertions را در unit tests پیاده کن.

**پایان فاز:** schema و `FakeDrive` کاملاً testable؛ هیچ درخواست شبکه واقعی برای تست موتور لازم نباشد.

## فاز 2 — Auth و Google Drive Adapter واقعی

**اقدامات:**

1. Google OAuth Desktop with PKCE/system browser/loopback با Cancellable Flow، Keychain، refresh serialized؛ بدون server و secret.
2. Config template + app registration guide + detection of missing client ID.
3. `files.list/get/create/generateIds`, `changes.getStartPageToken/list`, media download, multipart/resumable upload، metadata `appProperties`, `fields` masks و pagination.
4. Vault folder ownership verification و account binding; `fileId`-based cache؛ Root marker و duplicate handling.
5. Timeout, retry, backoff, quota meter, progress و cancellation semantics.
6. Tests با HTTP stub/recording fixtures و ساختار mock server؛ Live integration فقط در صورت وجود credential واقعی.

**پایان فاز:** adapter بدون وابستگی به UI قادر به create/read immutable test object و تغییرات آن است؛ error mapping تست دارد.

## فاز 3 — پایدارسازی Outbox/Inbox و انتشار

**اقدامات:**

1. durable Outbox/Inbox و snapshot-of-last-published در app-data Vault-scoped/SQLite یا journal متناسب با پروژه.
2. single-flight worker و coordinated state recovery هنگام restart؛ دو instance روی یک Vault باید lock بین‌پردازه‌ای معتبر یا error روشن داشته باشند.
3. dirty tracking + diff capture از JSON واقعی، operation generation، coalescing و stable sequence allocation.
4. upload assets → batch marker → remote verification → local ack به‌صورت idempotent.
5. Unknown-result recovery, unchanged no-op suppression, connection drop، publish collision.
6. Crash injection در هر boundary، از جمله بعد از Write/FSync و قبل/بعد Ack.

**پایان فاز:** 100 بار تکرار انتشار/Crash با 0 lost local edits و 0 duplicate-applied operations؛ بدون Commit Git.

## فاز 4 — دریافت تغییرات و Merge واقعی

**اقدامات:**

1. initial listing + changes catch-up بدون race و cursor update پس از durable discovery.
2. durable replay با sequence-gap detection، causal predecessors، frontier و deterministic ordering.
3. Tiptap stable node ID migration (نسخه‌دار و با backup)، schema-preserving transformation.
4. merge مستقل metadata/block/structural operations با conflict archive.
5. DB record/relations/allocator، KV policies، attachment reference و delete/edit resurrection.
6. connect به `snapshot-apply`/journal و `vault-changed`/editor refresh بدون از دست رفتن unsaved typing.
7. property-based tests و random operation ordering تست کن.

**پایان فاز:** دو یا سه FakeDevice با تمام orderهای دریافت، به canonical state و conflict set برابر می‌رسند؛ موارد غیرقابل‌ادغام archive می‌شوند.

## فاز 5 — Checkpoint، onboarding، History و GC محافظه‌کارانه

**اقدامات:**

1. consistent snapshot capture، streamed object publication، manifest-last و hash/schema verification.
2. Checkpoint selection با frontier dominance، concurrent checkpoints، replay uncovered tails.
3. new-device staged restore با full assets، exactly same Vault ID و fresh Device ID.
4. offline-old-device rebase با preimage; invalid/missing base → safe repair state.
5. Remote history list/preview/restore as copy، retention inventory.
6. `GC planner`, dry-run, proof-of-coverage, cold restore verification, guarded quarantine/rollback; disable destructive mode if proofs cannot be established.
7. synthetic long-offline/compaction tests.

**پایان فاز:** empty device bootstrap deterministic؛ بعد از safe simulated compaction هم restore موفق؛ اگر GC destructive gate ناامن است، کد و گزارش باید explicit fail-closed باشد.

## فاز 6 — UI، Provider routing و UX کامل

**اقدامات:**

1. صفحه Google Drive Connect: Sign in, verify account, Create/Choose remote Vault, pause/resume, reconnect, disconnect.
2. `Sync Now` با flush ادیتور، state کامل progress و last verified ack.
3. `Provider` selector: `Local only`, `GitHub (legacy)`, `Google Drive`; provider switching با backup و عدم دو Sync writer هم‌زمان.
4. conflict review با base/candidates و resolving operation پایدار.
5. History و Restore points؛ Diagnostics برای Pending, Errors, quota, file count, bytes, logs redacted.
6. پیام خطای قابل‌فهم برای Offline, Revoked, Rate Limit, Storage Full, Missing Remote, Duplicate Vault, Identity Mismatch.
7. Flag پیش‌فرض: Dev Preview اجازه Drive؛ **در Release، فقط پس از passing gates** پیش‌فرض Google Drive، نه silent automatic migration.

**پایان فاز:** از UI اصلی Nevis مسیر Create Vault → Connect Drive → Edit → Sync → New Device → Conflict Review → Restore قابل دنبال‌کردن باشد.

## فاز 7 — تست خودکار جامع، Performance، Build و release readiness

**اقدامات:**

1. ماتریس کامل بخش I را تا حد امکان به Unit/Integration/End-to-end scripts وصل کن.
2. Run `cargo test`, project JS tests/typecheck/lint/build، `tauri build` برای host در صورت موجود بودن؛ از اسکریپت واقعی repo استفاده کن.
3. Mock API load/performance: 1000 pages، 10000 blocks، 10000 batches، 1000 objects، فایل بزرگ با streaming؛ memory ceiling و request metrics ثبت شوند.
4. Cold start/restore/replay benchmarks و UI response profiling، اصلاح bottleneckهای واقعی.
5. Failures discovered را رفع و تست regression بساز؛ تست‌های skipped علل دقیق داشته باشند.
6. Documentation: `ARCHITECTURE.md`, `PROTOCOL.md`, `GOOGLE_SETUP.md`, `TROUBLESHOOTING.md`, `TEST_RESULTS.md`, `MIGRATION.md`, `ROLLBACK.md`, `DECISIONS.md`, `IMPLEMENTATION_PROGRESS.md`.
7. Manual scripts برای Windows/macOS با دو Device واقعی و OAuth/Drive حساب تست بنویس.
8. گزارش نهایی بخش K را به کاربر بده. Push/Release خارج از مخزن فقط با مجوز صریح؛ خودکار روی حساب واقعی کاربر destructive عمل نکن.

**پایان فاز:** هر capability ادعایی با تست یا مستند failure/blocker مرتبط؛ هیچ path حیاتی بدون recovery/error model باقی نماند.

---

# بخش I — ماتریس جامع Edge Case و تست پذیرش

**قانون هر تست:** هم `expected outcome` و هم `invariant` باید در test assertions دیده شوند. `PASS` فقط برای اجرای واقعی test. برای integration live، با حساب تست و داده بی‌ارزش؛ هرگز روی حساب شخصی اصلی destructive experiments اجرا نشود.

## I1. Local persistence / outbox / crash (P0)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| L01 | برنامه حین تایپ قبل از flush UI بسته شود | آخرین تغییر confirm‌نشده به‌عنوان Saved locally نمایش داده نشود؛ اگر flush موفق بود، حفظ شود |
| L02 | Crash بعد از local write و قبل از outbox insert | dirty tracking در restart تغییر را از دست ندهد؛ از local state مجدد reconcile شود |
| L03 | Crash وسط نوشتن journal/outbox | recovery idempotent، نه فایل ناقص/seq پرت |
| L04 | تغییر صفحه حین HTTP upload قبلی | batch قبلی immutable، تغییر تازه در نوبت بعد |
| L05 | worker هم‌زمان از timer و Sync Now | فقط یک flight، trigger دوم coalesced |
| L06 | دو process یک Vault را باز کنند | interprocess lock یا fail-safe؛ no concurrent corruption |
| L07 | filesystem full/read-only | local storage error واضح؛ ادعای Save/Sync موفق ممنوع |
| L08 | Vault path ناپدید شود | توقف و خطا؛ نه ساخت empty Vault و نه remote delete |
| L09 | unexpected local file edit از ابزار خارجی | capture با preimage/validation یا conflict؛ تغییر خام overwrite نشود |
| L10 | retry بعد از restart با outbox persist‌شده | همان batch/seq بررسی و منتشر؛ duplicate منطقی صفر |

## I2. OAuth / Drive API / identity (P0/P1)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| A01 | login cancel/timeout | local save مستقل؛ وضعیت NOT_CONNECTED؛ token ناقص ذخیره نشود |
| A02 | refresh token منقضی/revoked | AUTH_REQUIRED؛ outbox حفظ؛ reconnect قابل‌انجام |
| A03 | OS Keychain unavailable | fail-closed و توضیح؛ fallback به plaintext token ممنوع |
| A04 | دو حساب Google مختلف | account/root mismatch؛ هیچ overwrite cross-account |
| A05 | فایل/فولدر renamed در Drive | file ID binding معتبر بماند؛ با name اشتباه reinitialize نشود |
| A06 | دو فولدر `Nevis` هم‌نام | انتخاب با verified ID/root marker؛ عدم split-brain silent |
| A07 | cross-device `drive.file` discovery | فایل ساخت A روی B با همان OAuth app identity قابل کشف؛ در غیر این صورت gate blocked و راهکار approved |
| A08 | permission removed / root deleted | Remote unavailable؛ local data untouched؛ repair/reselect صریح |
| A09 | quota 403/429 و `Retry-After` | exponential backoff؛ Sync Now bypass نکند |
| A10 | 401 refresh لازم / refresh هم شکست | single refresh flow؛ تکرار بی‌نهایت ممنوع |
| A11 | 5xx / network timeout / TLS error | outbox محفوظ، retries bounded+backoff |
| A12 | Drive storage full و 403 insufficient storage | پیام دقیق؛ Local safe؛ متوقف شدن Retry بی‌فایده |
| A13 | پاسخ API بسیار کند | UI responsive؛ cancellation امن؛ timeout منطقی |
| A14 | app در OAuth Testing/Production | setup docs و رفتار اتصال آزمایشی واقعاً بررسی شود |

## I3. Publish / blob / integrity (P0)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| P01 | Upload asset موفق، batch fail | asset orphan موقت؛ local outbox باقی؛ GC ناامن نشود |
| P02 | Upload batch موفق، response گم‌شده | lookup file ID/hash؛ no duplicate content publish |
| P03 | تکرار same batch N بار | فقط یک operation logical apply؛ sequence stable |
| P04 | batchId یکسان با payload متفاوت | INTEGRITY_ERROR؛ هیچ overwrite |
| P05 | Device ID/sequence collision | Sync pause و repair؛ نه انتخاب تصادفی |
| P06 | batch کامل اما required asset مفقود | defer apply کل atomic group، نه reference شکسته |
| P07 | media truncation و incorrect SHA | رد payload و Retry/Repair؛ عدم corrupt local write |
| P08 | gzip bomb / oversized JSON / deep nesting | رد قبل از تخصیص حافظه خطرناک |
| P09 | 0 changes + Sync Now | هیچ batch/file جدیدی منتشر نشود |
| P10 | هزاران تغییر یک بلاک در 60 ثانیه | coalesce، انتشار محدود بدون تغییر معنا |
| P11 | فاصله غیرعادی timestamp device | ترتیب از seq/frontier، نه timestamp |
| P12 | remote asset با same hash/metadata name ولی bytes متفاوت | verify bytes hash و incident |

## I4. Discovery / replay / causal ordering (P0)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| D01 | تغییر در فاصله initial startToken و full inventory | با changes catch-up کشف؛ no missing batch |
| D02 | `changes.list` چند صفحه + crash وسط pagination | cursor فقط بعد از durable discover جلو برود |
| D03 | invalid/expired changes token | full safe rescan؛ local data حذف نشود |
| D04 | same change item دوبار گزارش شود | ingest idempotent |
| D05 | batch seq 10 قبل از seq 9 برسد | WAITING_DEPENDENCY، سپس replay |
| D06 | prevBatchId نادرست | integrity/dependency error؛ no silent skip |
| D07 | `removed` در Drive feed | page tombstone نباشد |
| D08 | دستگاه A و B concurrent publishes | هر دو batch discover و merge؛ آخرین response برنده نیست |
| D09 | arbitrary ordering of 100 batches | یک canonical state و conflict set برای همه orderها |
| D10 | duplicate requests بعد از recovery | local frontier دقیق، no extra apply |
| D11 | permission changes وسط download | توقف با state روشن، حفظ Inbox durable |
| D12 | فایل ناشناخته/آلوده توسط کاربر در Nevis folder | ignore/quarantine؛ نه arbitrary path write |

## I5. Page blocks / structural merge (P0)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| M01 | A عنوان page، B یک paragraph دیگر را تغییر دهد | Merge خودکار هر دو |
| M02 | A/B متن یک بلاک را هم‌زمان و متفاوت عوض کنند | دو candidate + base در conflict؛ no data loss |
| M03 | دو insert concurrent در یک index | هر دو موجود؛ ترتیب deterministic |
| M04 | move یک بلاک + edit همان بلاک | move و edit هر دو محفوظ، اگر سازگار |
| M05 | دو move concurrent به ستون‌های متفاوت | conflict با هر دو موقعیت قابل بازیابی |
| M06 | delete parent + append child | orphan-safe conflict/recovery، نه حذف child |
| M07 | افزودن ستون + تغییر محتوا در ستون دیگر | merge ساختاری valid |
| M08 | copy/paste یا duplicate صفحه | stable IDs برای نودهای جدید یکتا |
| M09 | undo/redo بعد از incoming update | هیچ unsaved user edits از دست نرود؛ selection معقول |
| M10 | schema/plugin node ناشناخته | preserved opaque یا error+archive، نه strip silent |
| M11 | legacy page بدون block IDs | migration deterministic با backup و fixture |
| M12 | Rich Text marks/links/task/equations/images | serialization و hydrate بدون از دست‌رفتن معنا |
| M13 | concurrent metadata key changes | fieldwise merge مستقل |
| M14 | page-level replace-safe + concurrent block change | preimage-based reconcile یا archive؛ no blind overwrite |

## I6. Database / KV / deletion (P0)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| B01 | A یک property، B یک field دیگر همان record را edit کند | merge fieldwise اگر type permits |
| B02 | دو edit ناسازگار یک field | record conflict با same ID، no random clone |
| B03 | concurrent relation/edge updates | referential integrity و deterministic outcome |
| B04 | atomic multi-record batch و crash وسط apply | all-or-none، recovery journal |
| B05 | ID allocation هم‌زمان روی دو دستگاه | no collision یا explicit integrity error |
| B06 | kv stale UI cache بعد از remote update | stale value نباید remote جدید را overwrite کند |
| B07 | theme global و font size device-local | policy per-key رعایت، secret/local setting sync نشود |
| B08 | A page delete، B offline edit همان page | Resurrect page با همان ID + history/tombstone preserved |
| B09 | دو delete موازی یک صفحه | one logical deletion, no duplicate invalid event |
| B10 | Remote file vanished بدون tombstone | هیچ page delete ایجاد نشود |
| B11 | صفحه با asset reference در conflict/history | asset GC ممنوع تا references آزاد |
| B12 | page permanent-delete UI و offline device | توضیح retention؛ هیچ وعده global permanent erasure |

## I7. Checkpoint / history / compaction / devices (P0)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| C01 | Crash وسط checkpoint objects upload | manifest معتبر منتشر نشود؛ prior checkpoint usable |
| C02 | manifest published ولی object missing | checkpoint invalid، fallback safe |
| C03 | دو concurrent checkpoints با incomparable frontiers | انتخاب براساس coverage/merge؛ نه timestamp |
| C04 | fresh device از remote خالی محلی | تمام pages/DB/assets حاضر؛ no delete upload |
| C05 | device offline یک ماه ویرایش کرده | rebase/merge با latest checkpoint، old edits preserved |
| C06 | device offline بدون ویرایش و GC شده | rebootstrap از checkpoint و frontier درست |
| C07 | legacy older client incompatible protocol | migrate/fail closed؛ state remote overwrite نشود |
| C08 | GC crash بعد از حذف بخشی از candidates | replay/recovery از checkpoint+remaining data موفق |
| C09 | GC dry-run به object reference مهم می‌رسد | object retained، report reason |
| C10 | restoration of an older History checkpoint | preview و restore as copy؛ Vault فعلی سالم |
| C11 | checkpoint with 1000 pages + 1000 assets | streaming bounded memory و hashes برابر |
| C12 | local backup restored روی دستگاه دوم | fresh Device ID، no seq collisions |
| C13 | manifest tampering/corrupt inventory | reject، repair workflow؛ no silent overwrite |
| C14 | no valid checkpoint left | replay valid stream یا explicit recovery error؛ empty state not accepted |

## I8. Migration / UI / performance / security (P1/P0)

| ID | سناریو | نتیجه اجباری |
|---|---|---|
| U01 | Vault قبلی GitHub به Drive migrate شود | backup، explicit switch، Drive init امن؛ GitHub unchanged |
| U02 | provider switch while pending outbox | block unsafe switch یا حفظ/export pending + clear recovery choice |
| U03 | disconnected Drive | local Vault و backup باقی بماند |
| U04 | Preview & Release نصب کنار هم | token/service IDs جدا، binding اشتباه مشترک نشود |
| U05 | Sync status changes during upload | UI state درست؛ Sync Now ack تا پایان ارسال ندهد |
| U06 | Conflict unresolved but independent file changed | independent updates sync؛ status conflict visible |
| U07 | simulate 10k blocks / 10k changes | memory/time/request budget ثبت و قابل‌قیاس |
| U08 | large media upload interrupted then resumed | byte hash intact؛ resumable/streaming |
| U09 | file path traversal / case collision | reject before fs writes |
| U10 | token/content appear in logs | automated redaction tests؛ leak صفر |
| U11 | external Drive rename/move Nevis folder | stable IDs / repair بدون destructive rebootstrap |
| U12 | Drive API rate limit prolonged 24h | local saves remain, retry bounded, visible status |
| U13 | no change for 8h app open | no remote writes، only budgeted polling |
| U14 | several Vaults | policy فقط active Vault صریح؛ UI inactive syncing ادعا نکند |
| U15 | export + clean reinstall + import | local backup complete و provider rebinding آگاهانه |
| U16 | Reconnect after logout/account switched | token/binding consistency, no cross-account operations |

**مجموع: 104 سناریوی تست نام‌گذاری‌شده.** شمار PASS/FAIL/NOT_RUN را AI باید در `TEST_RESULTS.md` به‌صورت محاسبه‌شده ثبت کند. موارد P0 با mock/fault fixtures باید تا حد ممکن خودکار شوند. اجرای دستی واقعی روی دو OS، اگر محیط وجود ندارد، با وضعیت `NOT_RUN / external dependency` گزارش شود؛ نه PASS.

---
# بخش J — الزامات دقیق کیفیت و پایش اجرا

## J1. تست‌های مختلف و نحوه اجرای آن‌ها

**Unit:** serialization, canonical hashing, stable node ID migration, per-operation diff, merge, tombstone rules, frontier arithmetic, state machine, token redaction, outbox journaling.

**Property-based:** generated concurrent edit sequences، permutations و random crash points؛ invariantهای «همگرایی»، «no silent loss»، «idempotent replay» و «reference integrity».

**Integration with FakeDrive:** دو یا سه Nevis client واقعی domain-level، جدا در directory/test DBهای مستقل، روی یک adapter جعلی مشترک؛ تغییرات تصادفی، crash و failover.

**HTTP Adapter Tests:** Stub endpoint با responseهای Google API: 200/201/204/400/401/403/404/409/429/5xx، pagination، resume status و gzip/truncation.

**Live Google (در صورت credential واقعی):** Test OAuth app، حساب تست مجزا، ایجاد Vault، device A/B، قطع اینترنت، reopen، delete/rename فولدر، asset upload/download؛ تمام فایل‌ها در فولدر تست. هیچ پاک‌سازی خارج از فولدر تست.

**UI Tests:** saveForSync، state transitions، reconnect/cancel، conflict review، no echo، editor unsaved edits.

**Build:** از scriptهای واقعی repo استفاده کن؛ در صورت نبود dependency یا SDK، علت و command مشخص بده. «روی macOS ساخته شد» را بدون macOS host اثبات‌شده اعلام نکن.

## J2. دسترسی‌پذیری و داده آزمون

Test fixtures ثابت بساز که حداقل این‌ها را پوشش دهند: RTL فارسی، Unicode emoji، متن طولانی، inline code و Code Block، Quote، heading، task list، tables، multi-column، nested list، image/GIF/attachments، 13 database record types، جابه‌جایی، حذف و conflict. UI هیچ تغییر مبهم به محتوای HTML/JSON اعمال نکند.

## J3. معیارهای کمی اولیه

اعداد زیر **هدف آزمون** هستند، نه تضمین سرویس Google:

| معیار | هدف/شیوه ارزیابی |
|---|---|
| Lost acknowledged local writes | 0 در suite fault injection |
| Duplicate applied operations | 0 در replay/retry/crash tests |
| Silent conflict loss | 0؛ هر اختلاف unresolved باید archive قابل Restore داشته باشد |
| Convergence | hash canonical state و conflict IDs برابر پس از تکمیل مجموعه یکسان تغییرات |
| Idle remote writes | 0 وقتی dirty/outbox خالی است |
| Crash recovery | بدون corrupt local vault، بدون deadlock یا reset پنهان |
| Upload amplification | ثبت bytes sent / bytes logical changed؛ هدف کاهش قابل مشاهده نسبت به full-page sync |
| Memory | اندازه‌گیری واقعی روی داده حجیم؛ full 95MiB+ attachment نباید الزاماً داخل JSON/Base64 RAM بار شود |
| Restore | 100% فایل‌های manifest معتبر و referenced assets روی دستگاه تازه موجود باشند |
| Google quota use | dashboard per operation با مجموع daily/per-user و هشدار نزدیک budget |
| Sync latency | median/p95 از زمان durable local write تا confirmed publish و سپس receive ثبت شود |

در صورت خطای پرفورمنس، ترجیح به حفظ صحت داده و نمایش Pending است؛ performance hack نباید precondition checks را حذف کند.

## J4. محافظت از build و سازگاری

- Windows/macOS installers و Tauri target settings را تغییر بی‌دلیل نده؛ روی خطاهای موجود packaging (مثل Windows WebView2 Loader) ضمن بازبینی build monitor کن اما به Sync نسبت نده.
- API contract و IPCهای موجود را تا جای ممکن stable نگه دار، و فرمان‌های جدید را namespaced اضافه کن (`google_connect`, `drive_sync_now`, `drive_sync_status`, ...).
- Migration local schema نسخه‌دار و با `before` backup/readback checksum؛ idempotent و قابل Retry.
- Feature flags با نام روشن `drive_sync_enabled` و `provider=drive`; مسیر GitHub فعلی از نظر build نشکند.
- هر تغییر برگشت‌ناپذیر در schema و Vault header باید compatibility marker و error روی نسخه قدیمی داشته باشد، نه fallback به parse اشتباه.

---

# بخش K — خروجی نهایی که AI موظف است تحویل بدهد

## K1. کد و فایل‌ها

در پایان سشن این deliverableها باید در مخزن قابل ارجاع باشند:

1. Sync Engine و Drive Adapter واقعی، نه pseudo-code.
2. OAuth Desktop (با template config، بدون credential واقعی داخل git).
3. Local durable journals, merge, checkpoint, history, GC guards.
4. UI کامل Provider selection، Sync state، Conflicts و diagnostics.
5. Automated unit/integration/fault tests و fixtures.
6. README/Setup/Protocol/Recovery/Migration/Rollback/Test Results.
7. Feature flag و مسیر fallback به GitHub تا cutover.
8. هیچ کد dead/duplicate غیرضروری یا import unresolved در تغییرات جدید.

## K2. گزارش پایان سشن — از همین قالب استفاده کن

```markdown
# Nevis Drive Sync — Execution Report

## 1. Outcome
- Overall status: COMPLETE / PARTIALLY VERIFIED / BLOCKED
- Production-ready: YES / NO (with evidence)
- Provider default: DRIVE / GITHUB / FLAGGED

## 2. Implemented
| Feature | Exact files/functions changed | Test evidence | Status |
| ... |

## 3. Acceptance tests
- Unit: <command>, <passed>/<failed>/<skipped>
- Integration/Fault: <command>, <passed>/<failed>/<skipped>
- UI: ...
- Live Google OAuth: PASS/FAIL/NOT_RUN and reason
- Windows packaging: PASS/FAIL/NOT_RUN and reason
- macOS packaging: PASS/FAIL/NOT_RUN and reason
- Convergence/performance benchmark numbers and dataset

## 4. Safety invariants
- Local save durable: evidence
- Duplicate replay prevention: evidence
- Publish recovery: evidence
- Conflict retention: evidence
- Delete-vs-edit resurrection: evidence
- Checkpoint restore: evidence
- GC fail-closed: evidence

## 5. External setup required (only if unavoidable)
- Google Cloud Project steps
- OAuth client configuration
- Specific live device/account testing procedure

## 6. Known limitations (no hidden TODO)
- <list of verified remaining limitations>

## 7. Changed files / Migration / Rollback
- Paths and high-level summary
- Source branch / commits (if any)
- How to revert without destroying local data
- How to resume failed migrations

## 8. Final user test script
- Windows device A
- macOS device B
- Offline conflict
- New device recovery
- Version restore
```

**توجه:** اگر همه فازهای کد کامل‌اند ولی Live Google test به خاطر نداشتن OAuth client/account اجرا نشده، `Overall status: PARTIALLY VERIFIED` و `Production-ready: NO` کاملاً درست و لازم است؛ **«کاملاً تست شده» ممنوع**.

## K3. سناریوهای تست دستی قابل‌تحویل به کاربر

در پایان، جداگانه یک `MANUAL_TEST.md` به‌صورت قدم‌به‌قدم تهیه کن که با داده تست و بدون CLI سنگین قابل اجرا باشد:

1. Google Connect در Windows؛ ساخت Vault با صفحه، جدول، چند ستون و عکس؛ اطمینان از local save.
2. Sync Now و اطمینان از Google Drive folder به‌همراه stream/checkpoint valid.
3. نصب روی macOS، همان Google account؛ discover Vault و دریافت همه صفحات/فایل‌ها.
4. خاموش کردن اینترنت هر دو دستگاه و تغییر دو بلاک مستقل؛ وصل و sync؛ مشاهده merge.
5. هم‌زمان تغییر همان بلاک در دو دستگاه؛ مشاهده Conflict، انتخاب نسخه و تأیید روی هر دو.
6. delete صفحه A و edit آفلاین B؛ پس از اتصال، همان صفحه باید resurrect شود.
7. خروج/Crash هنگام Upload و بازکردن دوباره؛ no lost data/duplicate.
8. دستکاری دسترسی/rename فولدر در یک حساب آزمایشی؛ وضعیت صحیح و بدون حذف Local.
9. بازگردانی Remote Checkpoint روی copy و تأیید صحت نسخه قدیمی.
10. pause/reconnect/logout؛ حساب دوم متصل شود، Vault اول دست‌نخورده بماند.

هر سناریو باید «نتیجه مورد انتظار»، «محل دیدن وضعیت در UI»، «در صورت شکست چه اطلاعات امنی برای گزارش لازم است» داشته باشد.

---

# بخش L — معیار نهایی توقف و روند تصمیم‌گیری بدون سؤال

## L1. اگر در اجرا با مانع مواجه شدی

| وضعیت | رفتار AI در همان سشن |
|---|---|
| فایل/ماژول واقعی با سند فرق دارد | به سورس واقعی تکیه کن؛ مسیر جدید را در DECISIONS ثبت کن؛ کار ادامه یابد |
| API رسمی با فرض پروتکل سازگار نیست | به safe alternative بدون scope گسترده برو؛ اگر تضمین data safety ممکن نیست، مسیر را disabled نگه دار و باقی اجرا کن |
| Google OAuth credentials وجود ندارد | کامل کردن کد/config، FakeDrive و HTTP tests؛ Live test NOT_RUN؛ راهنمای تنظیم دقیق |
| دستگاه Windows یا macOS در اختیار نیست | فقط host موجود را build/test کن؛ برای OS دیگر Script و Manual Test بده، نه PASS ساختگی |
| به اینترنت برای dependency دسترسی نیست | با dependencies موجود و کد موجود کار کن؛ خطا و command repeat را در گزارش ثبت کن |
| تست merge/convergence شکست خورد | اول bug را اصلاح و regression test اضافه کن، cutover ممنوع |
| GC coverage اثبات نمی‌شود | GC destructive default OFF؛ dry-run و Recovery کامل؛ صریحاً خطر رشد فایل‌ها را گزارش کن |
| داده Legacy ناپایدار/غیرقابل migrate است | backup، مسیر Safe migration، rollback؛ هیچ overwrite یا پاک‌کردن remote |
| تغییرات کاربر در git working tree وجود دارد | preserve existing edits، scope جداسازی؛ هیچ reset/force checkout/clean بدون اجازه |
| حجم کار بزرگ شد | کیفیت و ایمنی P0 مقدم؛ تا حد ظرفیت سشن همه فازها را اجرا کن، اما نتیجه ناقص را به‌عنوان کامل گزارش نکن |

## L2. اولویت حل نقص‌ها

**P0 (قبل از فعال‌کردن Drive برای داده واقعی):** local durability، no-lost-update، upload idempotency، stable device IDs، canonical merge/conflict archives، tombstones، staged restore، crash recovery، auth scope/credential safety، no destructive GC.

**P1 (قبل از عرضه عمومی):** UX، quota metrics، robust rebootstrap after compaction، remote history usable، performance و packaging دو سیستم‌عامل، OAuth publishing.

**P2 (بعداً فقط اگر واقعاً لازم شد):** real-time collaboration، E2EE طراحی‌شده مستقل، CRDT متن، multi-provider concurrent sync، موبایل، background sync همه Vaultها. این‌ها **از موضوع اجرا خارج‌اند** و نباید اجرای P0/P1 را عقب بیندازند.

## L3. ترتیب اجرای پایانی

قبل از نوشتن عبارت `Done` یا اعلام تکمیل:

1. test matrix را با `PASS / FAIL / NOT_RUN` پر کن.
2. خطاهای واقعی P0 را رفع کن؛ در صورت باقی‌ماندن، Drive default خاموش و status = NOT READY.
3. synthetic cold restore را از صفر انجام بده، نه فقط sync روی state موجود.
4. یک تست deterministic convergence دو/سه device با reordering اجرا کن.
5. پوشه‌های documentation و `MANUAL_TEST.md` را تولید کن.
6. `git diff --check`, lint/typecheck/test/build مربوطه را ثبت کن.
7. `IMPLEMENTATION_PROGRESS.md` را finalize و report قالب K2 را ارائه بده.
8. هیچ دسترسی/حساب/سرور یا زمان تست آینده‌ای را به‌عنوان انجام‌شده اعلام نکن.

---

# بخش M — منابع قابل استناد برای AI در هنگام اجرای کد

**ورودی اصلی پروژه:** `sync-architecture.md` (معماری فعلی Nevis، سند تاریخ 2026-10-28)، به‌ویژه بخش‌های Vault، ذخیره/Journal، GitHub Protocol، Snapshot Merge، Conflicts، History، Worker و Restore. لازم است AI فایل واقعی را از checkout بخواند؛ این سند وضعیت مستند است و صحت کد فعلی را تضمین نمی‌کند.

**Google Drive/Google OAuth official:**

- Drive OAuth scopes / `drive.file`: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Desktop OAuth PKCE: https://developers.google.com/identity/protocols/oauth2/native-app
- Change tracking: https://developers.google.com/workspace/drive/api/guides/manage-changes
- File creation / generated IDs: https://developers.google.com/workspace/drive/api/guides/create-file
- Upload formats and resumability: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Custom `appProperties`: https://developers.google.com/workspace/drive/api/guides/properties
- Drive quota units / limits (updated 2026): https://developers.google.com/workspace/drive/api/guides/limits
- Errors and backoff: https://developers.google.com/workspace/drive/api/guides/handle-errors
- File revisions (NOT Nevis History): https://developers.google.com/workspace/drive/api/guides/manage-revisions
- OAuth consent/publishing: https://support.google.com/cloud/answer/15549945?hl=en

**قانون منابع:** اگر API semantics یا قیمت/سهمیه با این فایل اختلاف داشت، مستندات رسمی روز اجرا و داده کنسول پروژه اولویت دارد. تغییری که safety را تحت تأثیر قرار می‌دهد باید با fixture جدید و ثبت تصمیم مستند شود؛ نه فرض خوش‌بینانه.

---

# آخرین دستور برای AI اجراکننده

**اکنون مخزن را باز کن، مراحل A تا M را به‌ترتیب انجام بده و کار را تا نقطه‌ای که تمام بخش‌های قابل‌اجرا در محیط حاضر پیاده و تست شده‌اند ادامه بده.** سؤال‌های ترجیحی و تاییدهای مرحله‌ای مطرح نکن؛ برای تصمیم‌های فنی طبق این سند و شواهد کد عمل کن. در صورت نبود دسترسی OAuth یا OS دوم، باقی کار را ادامه بده و نتیجه را با وضعیت قابل‌تأیید، blockers و دستور تست خارجی تمام کن. فقط تحلیل، خروجی RFC، اسکلت خالی، TODO یا نمایش Mock بدون وصل‌کردن به Nevis واقعی **تحویل این مأموریت نیست**.
