export interface IconEntry {
  name: string
  icon: string
  keywords: string
}

/**
 * The page icons the app ships. The host builds it from the UI's icon set, so documents/ never imports UI code.
 * An AI client may only set an icon the app can draw: `i:name` or `i:name@#rrggbb`.
 */
export interface IconCatalog {
  valid(icon: string): boolean
  search(query: string | undefined, limit: number): { icons: IconEntry[]; total: number }
}
