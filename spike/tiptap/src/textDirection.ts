const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u

export function firstTextDirection(text: string): 'rtl' | 'ltr' | null {
  const first = text.match(/\p{L}/u)?.[0]
  return first ? RTL_LETTER.test(first) ? 'rtl' : 'ltr' : null
}

