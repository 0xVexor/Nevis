// The editor's own UI strings (Persian). The app-wide i18n arrives with M8b; until then they live here, in one place.
export const S = {
  changeIcon: 'تغییر نماد', toggle: 'باز و بسته', column: (n: number) => `ستون ${n}`, editFormula: 'ویرایش فرمول', editDiagram: 'ویرایش نمودار', editDrawing: 'ویرایش نقاشی',
  done: 'تمام', cancel: 'لغو', save: 'ذخیره', remove: 'حذف', placeholderImage: 'جای تصویر', imageFromWeb: 'نشانی https تصویر', imageUnavailable: 'تصویر در دسترس نیست؛ نشانی را عوض کنید یا فایل را پیوست کنید', imageAttach: 'پیوست تصویر',
  tooLargeDrawing: 'این نقاشی از ۲۵۶ کیلوبایت بزرگ‌تر است و ذخیره نشد', pageLinkMissing: 'صفحه پیدا نشد', loading: 'در حال بارگذاری…', diagramError: 'نمودار خوانده نشد',
  formulaError: 'فرمول خوانده نشد', size: { s: 'کوچک', m: 'متوسط', l: 'بزرگ', full: 'تمام‌عرض' }, align: { start: 'ابتدا', center: 'وسط', end: 'انتها' },
  slash: { placeholder: 'بنویسید، یا برای دستورها / بزنید…', empty: 'موردی پیدا نشد' },
  find: { placeholder: 'جست‌وجو در صفحه', next: 'بعدی', prev: 'قبلی', close: 'بستن', count: (i: number, n: number) => `${i} از ${n}` },
  attachTooLarge: 'این فایل از حد مجاز بزرگ‌تر است و پیوست نشد', attachStorageFull: 'جای ذخیره‌سازی این دستگاه پر است و فایل پیوست نشد', attachFailed: 'پیوست کردن فایل انجام نشد',
  fileMissing: 'فایل هنوز نرسیده است…', notAnImage: 'این فایل تصویر نیست', download: 'دانلود', file: 'فایل', imageAlt: 'تصویر',
  drawingMissing: 'نقاشی هنوز از همگام‌سازی می‌رسد…',
  layoutNested: 'ستون‌ها درون هم نمی‌روند؛ بعد از ستون‌ها یک پاراگراف بنویسید',
} as const
