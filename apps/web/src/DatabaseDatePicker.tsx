import { useState } from 'react'
import { gregorianToJalali, jalaliToGregorian, validGregorian } from '@nevis/core'
import { Button, Icon, IconButton, Popover } from './ds'
import { locale, t } from './i18n'
import type { SyncedSettings } from './workspaceSettings'

const dayMs = 86_400_000
const weekStarts = { sun: 0, mon: 1, sat: 6 }
const civil = (year: number, month: number, day: number) => {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}

export function DatabaseDatePicker({ anchor, stored, settings, onSelect, onClose }: {
  anchor: DOMRect
  stored: string
  settings: SyncedSettings
  onSelect: (value: string) => void
  onClose: () => void
}) {
  const now = new Date()
  const today = civil(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString().slice(0, 10)
  const selected = stored ? stored.slice(0, 10) : undefined
  const [year, month, day] = (selected ?? today).split('-').map(Number) as [number, number, number]
  const jalali = settings.calendar === 'jalali'
  const [initialYear, initialMonth] = jalali ? gregorianToJalali(year, month, day) : [year, month]
  const [cursor, setCursor] = useState(initialYear * 12 + initialMonth - 1)
  const startOfMonth = (index: number) => {
    const y = Math.floor(index / 12)
    const m = index - y * 12 + 1
    const parts: [number, number, number] | null = jalali ? jalaliToGregorian(y, m, 1) : [y, m, 1]
    return parts && validGregorian(...parts) ? civil(...parts) : null
  }
  const first = startOfMonth(cursor) ?? civil(year, month, 1)
  const next = startOfMonth(cursor + 1)
  const weekday = weekStarts[settings.weekStart]
  const start = first.getTime() - ((first.getUTCDay() - weekday + 7) % 7) * dayMs
  const options = { calendar: jalali ? 'persian' : 'gregory', timeZone: 'UTC' }
  const header = new Intl.DateTimeFormat(locale(), { ...options, month: 'long', year: 'numeric' }).format(first)
  const weekdayFormat = new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', weekday: 'short' })
  const dayFormat = new Intl.DateTimeFormat(locale(), { ...options, day: 'numeric' })
  const dateFormat = new Intl.DateTimeFormat(locale(), { ...options, dateStyle: 'full' })
  const pick = (value: string) => onSelect(value ? value + (stored.slice(10) || '') : '')

  return (
    <Popover anchor={anchor} align={document.documentElement.dir === 'rtl' ? 'end' : 'start'} onClose={onClose}>
      <div className="dv-date dv-date-picker" role="dialog" aria-label={t('Calendar')}>
        <div className="dv-date-head">
          <IconButton label={t('Previous month')} disabled={!startOfMonth(cursor - 1)} onClick={() => setCursor(cursor - 1)}><Icon name="chevron-left" size={16} className="ds-flip" /></IconButton>
          <b aria-live="polite">{header}</b>
          <IconButton label={t('Next month')} disabled={!next} onClick={() => setCursor(cursor + 1)}><Icon name="chevron-right" size={16} className="ds-flip" /></IconButton>
        </div>
        <div className="dv-date-grid" role="group" aria-label={header}>
          {Array.from({ length: 7 }, (_, index) => <span key={index} className="dv-date-wd" aria-hidden="true">{weekdayFormat.format(civil(2024, 1, 7 + ((weekday + index) % 7)))}</span>)}
          {Array.from({ length: 42 }, (_, index) => {
            const date = new Date(start + index * dayMs)
            const value = date.toISOString().slice(0, 10)
            const inMonth = date.getTime() >= first.getTime() && date.getTime() < (next?.getTime() ?? Infinity)
            return <button key={index} type="button" className="dv-date-day" data-date={value} data-out={!inMonth || undefined} data-today={value === today || undefined}
              aria-label={dateFormat.format(date)} aria-pressed={value === selected} disabled={date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999} onClick={() => pick(value)}>{dayFormat.format(date)}</button>
          })}
        </div>
        <div className="dv-date-foot">
          {stored && <Button size="sm" variant="ghost" onClick={() => pick('')}>{t('Clear')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => pick(today)}>{t('Today')}</Button>
        </div>
      </div>
    </Popover>
  )
}
