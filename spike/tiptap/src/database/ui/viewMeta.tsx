import type { ViewType } from '../model/types.ts'
import type { ReactElement } from 'react'
import * as Ic from '../../icons'

export const VIEW_LABEL: Record<ViewType, string> = {
  table: 'Table', board: 'Board', list: 'List', gallery: 'Gallery', calendar: 'Calendar', timeline: 'Timeline', chart: 'Chart', map: 'Map', feed: 'Feed', form: 'Form', dashboard: 'Dashboard',
}
export const VIEW_ICON: Record<ViewType, () => ReactElement> = {
  table: () => <Ic.Table size={14} />, board: () => <Ic.Blocks size={14} />, list: () => <Ic.List size={14} />, gallery: () => <Ic.Cards size={14} />, calendar: () => <Ic.Clock size={14} />,
  timeline: () => <Ic.Layers size={14} />, chart: () => <Ic.Diagram size={14} />, map: () => <Ic.Globe size={14} />, feed: () => <Ic.Reader size={14} />, form: () => <Ic.Clipboard size={14} />, dashboard: () => <Ic.Home size={14} />,
}
