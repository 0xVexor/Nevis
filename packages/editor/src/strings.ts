// The editor's own UI strings (Persian). The app-wide i18n arrives with M8b; until then they live here, in one place.
export const S = {
  changeIcon: 'تغییر نماد', toggle: 'باز و بسته', column: (n: number) => `ستون ${n}`, editFormula: 'ویرایش فرمول', editDiagram: 'ویرایش نمودار', editDrawing: 'ویرایش نقاشی',
  done: 'تمام', cancel: 'لغو', save: 'ذخیره', remove: 'حذف', placeholderImage: 'جای تصویر (پیوست‌ها در به‌روزرسانی بعدی می‌آیند)', imageFromWeb: 'نشانی https تصویر',
  tooLargeDrawing: 'این نقاشی از ۲۵۶ کیلوبایت بزرگ‌تر است و ذخیره نشد', pageLinkMissing: 'صفحه پیدا نشد', loading: 'در حال بارگذاری…', diagramError: 'نمودار خوانده نشد',
  formulaError: 'فرمول خوانده نشد', size: { s: 'کوچک', m: 'متوسط', l: 'بزرگ', full: 'تمام‌عرض' }, align: { start: 'ابتدا', center: 'وسط', end: 'انتها' },
  slash: { placeholder: 'بنویسید، یا برای دستورها / بزنید…', empty: 'موردی پیدا نشد' },
  find: { placeholder: 'جست‌وجو در صفحه', next: 'بعدی', prev: 'قبلی', close: 'بستن', count: (i: number, n: number) => `${i} از ${n}` },
  layoutNested: 'ستون‌ها درون هم نمی‌روند؛ بعد از ستون‌ها یک پاراگراف بنویسید',
} as const
