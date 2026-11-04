import { SettingsWorkspace, type Category } from '../../settings-ui/SettingsWorkspace'
import { ExtraSettings, SettingsContext } from './ExtraSettings'
export function Study() {
 const categories: Category[] = ['data','database','connections','shortcuts','about']
 return <SettingsWorkspace panels={Object.fromEntries(categories.map(category => [category, <ExtraSettings key={category} category={category} />]))} context={category => <SettingsContext category={category} />} />
}
