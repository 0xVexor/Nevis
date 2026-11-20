# R7: آیا JSON قالب داده‌ی این پروژه است؟

- تاریخ: 2026-11-20
- روش: منابع اولیه (RFC، مشخصات، مستندات رسمی) با URL، و خواندن کد قدیمی Nevis (`spike/tiptap/src-tauri/nevis-core/src/api.rs`، `spike/tiptap/src-tauri/src/vault.rs`، `spike/tiptap/src-tauri/src/sync/snapshot.rs`، `docs/adr/0002-data-model.md`).
- برچسب‌ها: `[source]` منبع اولیه با URL، `[secondary]` وبلاگ یا منبع ثانویه، `[repo]` کد قدیمی، `[inference]` استنتاج من، بدون منبع مستقیم.

## معنای این برای تصمیم ما

1. JSON برای تبادل متن باید UTF-8 و بدون BOM باشد [source: https://www.rfc-editor.org/rfc/rfc8259 §8.1].
2. نام‌های یک شیء JSON «SHOULD» یکتا هستند و تکرار آن‌ها رفتار نامشخص دارد [source: RFC 8259 §4].
3. عددهای JSON در عمل دقت IEEE-754 double دارند؛ اعداد صحیح بین -(2^53-1) و 2^53-1 بین پیاده‌سازی‌ها یکسان‌اند [source: RFC 8259 §6].
4. RFC 8785 (JCS) برای بایت‌های قطعی: کلیدها بر اساس واحد کد UTF-16 مرتب، بدون فاصله، بدون NaN/Infinity، بدون surrogate تنها، و بدون نرمال‌سازی رشته [source: https://www.rfc-editor.org/rfc/rfc8785].
5. تابع `canonical()` در کد قدیمی با `serde_json::to_vec_pretty` پیاده‌سازی شده، یعنی خروجی pretty است و نام «canonical» تضمین بایتی ندارد [repo]. ترتیب کلیدها هم به پیش‌فرض serde_json وابسته است [inference].
6. RFC 8949 (CBOR) بخش 4.2 «deterministic encoding» دارد؛ MessagePack چنین تعریفی ندارد [source: https://www.rfc-editor.org/rfc/rfc8949 و https://github.com/msgpack/msgpack/blob/master/spec.md].
7. SQLite JSONB از نسخه 3.45.0 است، باینری روی دیسک، و به گفته‌ی خود SQLite «۵ تا ۱۰٪» کوچک‌تر و کمتر از نصف چرخه‌ی CPU است [source: https://sqlite.org/jsonb.html].
8. Yjs update باینری است و README آن را «preferred encoding» می‌داند؛ README یادآوری می‌کند که JSON تاریخچه‌ی همکاری را ذخیره نمی‌کند [source: https://github.com/yjs/yjs و https://github.com/yjs/y-prosemirror].
9. Protobuf فیلدهای ناشناخته را حفظ می‌کند، ولی تبدیل به JSON می‌تواند آن‌ها را از بین ببرد؛ شماره و نام حذف‌شده باید `reserved` شوند [source: https://protobuf.dev/programming-guides/proto3/].
10. مشخصات JSON Schema draft 2020-12 منتشر شده، اما صفحه‌ی رسمی درباره‌ی کلیدواژه‌های ناشناخته چیزی نمی‌گوید [source: https://json-schema.org/draft/2020-12].
11. TC39 «JSON.parse source text access» در مرحله‌ی 4 است و `JSON.rawJSON` و `context.source` را برای عددهای بزرگ اضافه می‌کند [source: https://github.com/tc39/proposal-json-parse-with-source].
12. Actual Budget پیام‌ها را به شکل tuple با HLC و Protocol Buffers ذخیره می‌کند و رمزنگاری را اختیاری روی دستگاه انجام می‌دهد؛ مشخصات رسمی سیم را پیدا نکردم [secondary: https://jlongster.com/using-crdts-in-the-wild].

## 1. آیا JSON مناسب است؟ (مقایسه بر اساس کاربرد)

| گزینه | حجم | سرعت و ابزار | خوانایی | تکامل شِما | JS / Go / Rust | استریم و فشرده‌سازی |
|---|---|---|---|---|---|---|
| JSON | متوسط؛ باینری‌ها +۳۳٪ با base64 [inference] | `JSON.parse` بومی مرورگر؛ پشتیبانی همه‌جا | عالی | ضعیف مگر با `schemaVersion` و قاعده‌ی tolerant reader | همه | خوب با gzip/brotli؛ نسبت فشرده‌سازی اندازه‌گیری نشده |
| NDJSON / JSON Lines | مثل JSON | مثل JSON، خط‌به‌خط | خوب | مثل JSON | همه | عالی برای export و log؛ هر خط یک مقدار JSON، UTF-8 بدون BOM، جداکننده LF [source: https://jsonlines.org] |
| CBOR (RFC 8949) | کوچک‌تر از JSON؛ باینری بدون base64 [inference] | دیکدر باینری؛ اندازه‌گیری نشده | ضعیف (ابزار debug لازم) | خوب با tag و map | کتابخانه‌ها موجودند، کیفیت نامعلوم | مناسب؛ `bytes` بدون base64 |
| MessagePack | کوچک‌تر از JSON [inference] | سریع‌تر از JSON در بسیاری بنچمارک‌ها [inference] | ضعیف | متوسط؛ type ext دارد | همه | بدون قاعده‌ی deterministic [source: msgpack spec] |
| Protobuf | کوچک؛ schema اجباری | سریع | ضعیف مگر با ابزار | عالی (`reserved`) [source] | همه؛ JS به کد تولیدی نیاز دارد | مناسب |
| FlatBuffers / Cap'n Proto | بزرگ‌تر یا بدون فشرده‌سازی | دسترسی بدون parse | ضعیف | متوسط | JS و Go و Rust دارند، کیفیت نامعلوم [inference] | برای دسترسی تصادفی به بافر مناسب است |
| BSON | نسبتاً بزرگ | متوسط | ضعیف | متوسط | همه | مناسب برای MongoDB، برای این پروژه انگیزه‌ی کمی دارد [inference] |
| SQLite JSONB | ۵–۱۰٪ کمتر از متن JSON [source] | سریع‌تر، ولی بایت‌ها را مستقیم نخوانید [source] | از طریق توابع JSON | قابل‌حمل بین نسخه‌ها [source] | فقط در SQLite | فشرده‌سازی ندارد |
| Yjs binary update | کوچک؛ فرمت V2 فشرده‌تر است [source] | دیکد باینری؛ بدون `Y.Doc` قابل merge و diff است [source] | ضعیف | نسخه‌ی V1/V2 دارد [source] | JS (کامل)، Rust و Go از پورت‌های جامعه [inference] | برای rich text ضروری است |

نتیجه‌ی جدول به تفکیک کاربرد:
- **ProseMirror JSON (صفحات):** JSON متنی بماند. سند محلی کوچک است و `toJSON` / `nodeFromJSON` استاندارد خود ProseMirror هستند [source: https://prosemirror.net/docs/guide/#doc.serialization]. Yjs برای همکاری زنده کنار آن می‌آید و تاریخچه‌ی Yjs باینری می‌ماند [source].
- **رکوردهای جدولی:** جدول normalized در SQLite، با ستون JSON برای مقادیر منعطف.
- **تنظیمات و kv:** JSON کافی است.
- **op envelope:** JSON برای نسخه‌ی اول قابل‌دفاع است؛ اگر payload باینری زیاد باشد، CBOR یا فریم باینری بهتر است [inference].
- **export:** NDJSON برای رکوردها + فایل manifest + بلاب‌های خام با sha256 (همین الگوی content-addressed در ADR 0002) [repo + inference].

## 2. گرفتاری‌های JSON در این پروژه

| مورد | واقعیت | روش استاندارد |
|---|---|---|
| عدد بزرگ و int64 | JSON عدد را double می‌کند؛ بالاتر از 2^53-1 دقت می‌ریزد [source RFC 8259 §6] | شناسه‌ها را به‌صورت رشته (UUIDv7) نگه دارید؛ HLC را رشته یا دو عدد جدا بگیرید؛ برای BigInt از `JSON.rawJSON` یا parse با `context.source` استفاده کنید (در مرحله‌ی 4 TC39) [source] |
| ترتیب کلید | JS ترتیب درج را نگه می‌دارد؛ Rust با `serde_json` پیش‌فرض (BTreeMap، مرتب) است و `preserve_order` ترتیب درج می‌دهد [inference: docs.rs صفحه‌ی ویژگی‌ها را برنگرداند؛ Cargo.toml پروژه قدیمی `serde_json = "1"` بدون feature دارد]؛ Go در Marshal کلیدهای map را مرتب می‌کند [inference] | برای هش فقط JCS یا CBOR deterministic؛ هرگز روی ترتیب کلید تکیه نکنید |
| کلید تکراری | RFC 8259 نامشخص می‌داند؛ بعضی آخرین را نگه می‌دارند؛ I-JSON آن را ممنوع می‌کند [source RFC 8785 §3.1] | parser را سخت‌گیر کنید: خطا بدهید |
| NaN / Infinity | در JSON نیستند؛ JCS خطا می‌دهد [source RFC 8785] | در ورودی رد کنید |
| یونیکد | JSON رشته را نرمال نمی‌کند؛ RFC 8785 هم نمی‌کند [source]. W3C پیشنهاد می‌کند NFC باشد [source: https://www.w3.org/TR/charmod-norm/] | در ورودی NFC کنید، ولی ZWNJ (نیم‌فاصله) را حذف نکنید چون معنا را تغییر می‌دهد [source W3C] |
| surrogate تنها | JSON مجاز است، اما متن معتبر یونیکد نیست [source RFC 8259 §8.2] | رد کنید (JCS هم خطا می‌دهد) |
| U+2028 / U+2029 | معتبر در JSON، و در JS هم بعد از ES2019 در literal مشکلی نیست [inference] | escape ننویسید مگر در HTML inline |
| escape سریالایزرها | JCS فقط escape کنترل‌ها را مشخص می‌کند؛ Go به‌صورت پیش‌فرض کاراکترهای HTML را escape می‌کند [inference؛ صفحه‌ی Go در دسترس نبود] | بایت‌ها را فقط با سریالایزر تعیین‌شده تولید کنید |
| payload بزرگ | JSON کل فایل را در حافظه parse می‌کند | برای بلاب‌ها از فایل جدا با sha256 استفاده کنید |
| `null` در برابر فیلد نبودن | باگ شما را نمی‌توانم از مستند y-prosemirror تأیید کنم؛ README آن درباره‌ی attrs چیزی نمی‌گوید [source] | قاعده‌ی schema: «فیلد نبود = مقدار پیش‌فرض»؛ `null` فقط اگر schema آن را تعریف کرده؛ قبل از هش نرمال کنید [inference] |

## 3. Canonical JSON و قطعیت

زمانی نیاز است که بایت‌ها هویت دارند: هش محتوا، امضا، dedupe.
زمانی نیاز نیست که بایت را opaque بگیرید: مثلاً به‌روزرسانی Yjs یا بلاب. آن‌ها را با sha256 روی بایت‌های خام هش کنید؛ کد قدیمی هم برای پیوست‌ها همین کار را می‌کند [repo, ADR 0002].

| استاندارد | قاعده‌ی کلیدی | یادداشت |
|---|---|---|
| RFC 8785 JCS | مرتب بر اساس UTF-16 code unit؛ بدون فاصله؛ اعداد با قاعده‌ی ECMAScript | پیاده‌سازی‌ها در Rust، JS، Go، Java و دیگر زبان‌ها [source: https://github.com/cyberphone/json-canonicalization]؛ صفحه‌ی آن هیچ ادعای تست انطباق ندارد |
| Matrix canonical JSON | مرتب بر اساس code point؛ فقط عدد صحیح در بازه‌ی ±(2^53-1)؛ بدون float و `-0` | برای امضای event استفاده می‌شود [source: https://spec.matrix.org/latest/appendices/#canonical-json] |
| DAG-JSON (IPLD) | کلیدها بر اساس بایت UTF-8؛ CID با `{"/": ...}`؛ bytes با base64 | JCS را ذکر نمی‌کند؛ مقایسه‌ی آن با JCS را من از منبع تأیید نکردم [source: https://ipld.io/specs/codecs/dag-json/spec/] |
| DAG-CBOR / CBOR deterministic | شکل کوتاه‌ترین، کلیدها بر اساس بایت‌های encoding | مشخصه‌ی رسمی [source RFC 8949 §4.2] |
| OLPC canonical JSON | — | تأیید نشد |
| JSON-LD URDNA2015 | — | تأیید نشد؛ برای این پروژه بیش‌ازحد است [inference] |

## 4. Schema، نسخه‌بندی و tolerant reader

- JSON Schema 2020-12 استاندارد توصیف schema است [source]. TypeBox، Zod، Valibot و ajv ابزار اجرایی آن یا معادل‌اند [inference؛ این‌ها را نیاوردم].
- ProseMirror schema قرارداد سند است؛ نسخه‌ی schema را جدا از نسخه‌ی envelope نگه دارید. ADR 0002 فیلد `content_schema` را همین‌طور پیشنهاد کرده است [repo].
- الگوی Protobuf: فیلد جدید اختیاری؛ فیلد حذف‌شده `reserved` [source]. این را برای JSON هم می‌شود اعمال کرد.
- Tolerant reader: فیلدهای ناشناخته نادیده گرفته شوند ولی ذخیره یا دوباره نوشته شوند تا داده‌ی نسخه‌ی جدیدتر گم نشود [inference؛ Protobuf همین را برای unknown fields می‌گوید، source].
- کلاینت قدیمی با داده‌ی جدیدتر: op ناشناخته را بدون بازنویسی ذخیره کنید و نمایش ندهید؛ نسخه‌ی major ناسازگار را رد کنید [inference].
- Cambria / lenses: پیشنهاد مهاجرت دوطرفه است؛ منبع اصلی را نخواندم [ندانسته].

## 5. استانداردهای سند rich text

- ProseMirror: `toJSON` و `schema.nodeFromJSON` رسمی‌اند [source]. شکل `type/attrs/content/marks/text` از دانش عمومی من است و در صفحه‌ی خوانده‌شده به‌صراحت نیامده [inference].
- Portable Text: آرایه‌ای از بلاک با `_type`، `_key`، `children`، `markDefs` است و هدفش رندر در هر قالب است [source: https://www.portabletext.org/]. یک استاندارد بین‌المللی رسمی نیست.
- Slate، Lexical، Quill Delta، Notion: شکل‌های اختصاصی‌اند؛ تأیید نکردم [ندانسته].
- اتخاذ استاندارد بیرونی برای سند فایده‌ی کمی دارد، چون شِما ProseMirror را دارد. Portable Text می‌تواند فرمت export باشد [inference].
- Markdown و HTML فقط نمای ثانویه‌اند و lossy‌اند [inference].

## 6. Op-log envelope

| سیستم | آنچه دیدم | منبع |
|---|---|---|
| Actual Budget | tuple (dataset, row, column, value, timestamp)، HLC، Protocol Buffers، رمزنگاری روی دستگاه | [secondary]، بدون مشخصه‌ی رسمی |
| Matrix | event با canonical JSON، امضای ed25519 روی JSON بدون `signatures` و `unsigned` | [source] |
| Replicache | mutation با نام و آرگومان JSON و شناسه | صفحه‌ی مستند 404 داد [ندانسته] |
| Standard Notes، Linear، ActivityPub | بررسی نشد | ندانسته |

حداقل envelope پیشنهادی [inference]:
- `v` نسخه‌ی فرمت
- `opId` (UUIDv7، رشته)
- `deviceId` و `actor`
- `hlc` (رشته‌ی قابل مقایسه)
- `kind`
- `keyId` (برای رمزنگاری آینده)
- `payload` (JSON یا بایت‌های خام)
- `aad` اگر رمزنگاری بیاید، همین بخش‌های سرآیند با canonical bytes امضا یا AAD می‌شوند

base64 هزینه‌ی +۳۳٪ دارد [inference از نسبت ۴/۳]. راه‌ها: CBOR با byte string؛ یا envelope JSON + payload باینری کنار آن (multipart یا فریم با طول). فشرده‌سازی: RFC 8878 (zstd، Informational و جایگزین RFC 8478) استریم با حافظه‌ی محدود دارد، dictionary بیرون از فریم است، و دسترسی تصادفی ندارد [source]. ادعای برتری zstd بر brotli برای JSON را من تأیید نکردم [ندانسته].

## 7. ذخیره در SQLite و IndexedDB

- SQLite: `json_extract` و JSONB از 3.45.0 هستند [source]. ایندکس روی مسیر JSON با generated column یا expression index ممکن است [inference؛ صفحه‌ی json1 در دسترس نبود].
- ستون JSON برای فیلدهای منعطف مناسب است؛ فیلدهای جستجو و فیلتر را ستون جدا یا جدول مشتق کنید (ADR 0002 همین را دارد، از جمله FTS5) [repo].
- IndexedDB: structured clone اشیای ساده، Map، Set، Date، ArrayBuffer را ذخیره می‌کند؛ prototype کلاس از بین می‌رود و تابع خطا می‌دهد [source: MDN]. BigInt در صفحه نبود؛ طبق قاعده‌ی primitive غیر از symbol احتمالاً پشتیبانی می‌شود [inference].
- structured clone دیگر نیازی به `JSON.parse` ندارد، ولی حجم و سرعت آن را اندازه نگرفتم [ندانسته].

## نیاز → گزینه‌های ممکن

| نیاز | گزینه‌ها |
|---|---|
| Unicode/فارسی | NFC ورودی، ZWNJ حفظ، JSON UTF-8 بدون BOM |
| قطعیت هش/امضا | JCS (RFC 8785) برای JSON؛ CBOR deterministic برای باینری؛ یا بایت خام با sha256 |
| عدد بزرگ | شناسه و HLC رشته؛ BigInt با `JSON.rawJSON` |
| تکامل شِما | `schemaVersion` در envelope؛ JSON Schema 2020-12؛ tolerant reader؛ `reserved` در Protobuf الگو |
| کارایی و حجم | CBOR یا فریم باینری برای payload؛ JSONB در SQLite؛ zstd یا brotli برای انتقال |
| debuggability | JSON و NDJSON برای export و log؛ CBOR با ابزار |
| رمزنگاری آینده | `keyId` و AAD روی canonical bytes |
| JS/Go/Rust | JSON و CBOR همه؛ Protobuf با codegen؛ Yjs در JS کامل |

## ندانسته‌ها

- json1 (sqlite.org)، صفحه‌ی Go encoding/json (403)، Replicache (404) و Yjs V2 جزئیات را تأیید نکردم.
- مقایسه‌ی عددی حجم و سرعت JSON، CBOR، MessagePack در مرورگر را پیدا یا اجرا نکردم؛ ادعاهای این گزارش در این باره [inference] است.
- نسبت فشرده‌سازی gzip، brotli و zstd روی داده‌ی واقعی ما را نسنجیدم.
- ترتیب کلید پیش‌فرض serde_json و اینکه `preserve_order` از راه وابستگی‌های دیگر فعال می‌شود یا نه را از Cargo.lock بررسی نکردم.
- مشخصه‌ی رسمی wire محصول Actual، Cambria، OLPC canonical JSON، Standard Notes، Linear و ActivityPub را ندیدم.
- باگ null در y-prosemirror را از مستندات تأیید نکردم؛ آن را از گزارش شما گرفته‌ام.
- سرعت `JSON.parse` در برابر دیکدرهای باینری در مرورگر را اندازه نگرفتم.
