import type { ViewType } from '../model/types.ts'
import { Icon } from '../../design-system'

export const VIEW_LABEL: Record<ViewType, string> = {
  table: 'Table',
  board: 'Board',
  list: 'List',
  gallery: 'Gallery',
  calendar: 'Calendar',
  timeline: 'Timeline',
  chart: 'Chart',
  map: 'Map',
  feed: 'Feed',
  form: 'Form',
  dashboard: 'Dashboard',
}

/** What each layout is for, shown when adding a view. */
export const VIEW_HINT: Record<ViewType, string> = {
  table: 'Rows and columns, edit like a spreadsheet',
  board: 'Cards in columns by status or group',
  list: 'One quiet line per item',
  gallery: 'Cards with a picture',
  calendar: 'Items on the days of their date',
  timeline: 'Bars across time, with dependencies',
  chart: 'Counts and sums as a chart',
  map: 'Items as pins on a map',
  feed: 'The text of each item, one after another',
  form: 'Questions that add an item',
  dashboard: 'Several views side by side',
}

const VIEW_ICON_NAME: Record<ViewType, string> = {
  table: 'table',
  board: 'board',
  list: 'list',
  gallery: 'gallery',
  calendar: 'calendar',
  timeline: 'timeline',
  chart: 'chart-bar',
  map: 'map',
  feed: 'feed',
  form: 'form',
  dashboard: 'dashboard',
}
export const ViewIcon = ({ type, size = 16 }: { type: ViewType; size?: number }) => <Icon name={VIEW_ICON_NAME[type]} size={size} />
