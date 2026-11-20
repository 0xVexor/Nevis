// The Net port over HTTP, against the real Go server (the same implementation the browser uses).
import { httpNet as coreHttpNet, type Net } from '@nevis/core'

export const httpNet = (base: string, token: string): Net => coreHttpNet({ base, token })
