import { GLYPHS } from '../iconSet'
import { DS_ICONS } from './iconData'

/** Every icon name <Icon> can draw: the design-system set first, then the page-icon glyphs. */
export const iconNames = () => [...Object.keys(DS_ICONS), ...Object.keys(GLYPHS).filter((n) => !(n in DS_ICONS))]
