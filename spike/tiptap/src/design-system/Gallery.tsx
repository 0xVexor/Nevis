import { useState } from 'react'
import { Button, IconButton } from './Button'
import { Card, Chip, Field, Section, Switch, Tabs } from './controls'
import { Row } from './Row'
import { Dialog, Tooltip } from './overlay'
import { Icon } from './icons'
import { COVER_SCENES, landscapeFor } from './scenery'
import './gallery.css'

/**
 * The component gallery (development only: open /#/design-system). Every component in left-to-right and right-to-left,
 * so a change can be checked in both directions at a glance; the theme button flips light and dark.
 */
function Pane({ dir }: { dir: 'ltr' | 'rtl' }) {
  const [on, setOn] = useState(true)
  const [tab, setTab] = useState('one')
  const [open, setOpen] = useState(false)
  const fa = dir === 'rtl'
  const title = fa ? 'یادداشت درس جاوا' : 'Java lecture notes'
  return (
    <div dir={dir} className="gallery-pane">
      <h2>{dir.toUpperCase()}</h2>
      <Section title="Buttons">
        <div className="gallery-line">
          <Button variant="primary">{fa ? 'ذخیره' : 'Save changes'}</Button>
          <Button>{fa ? 'انصراف' : 'Cancel'}</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">{fa ? 'حذف' : 'Delete'}</Button>
          <Button size="sm" icon={<Icon name="plus" size={14} />}>{fa ? 'جدید' : 'New'}</Button>
          <Tooltip label={fa ? 'افزودن' : 'Add'}><IconButton label={fa ? 'افزودن' : 'Add'}><Icon name="plus" /></IconButton></Tooltip>
        </div>
      </Section>
      <Section title="Row: the icon follows the text">
        <Card className="gallery-card">
          <Row icon={<Icon name="home" />} text={title} />
          <Row icon={<Icon name="home" />} text="Java lecture notes" />
          <Row icon={<Icon name="home" />} text="فصل ۱۵ — Graph" trailing={<Chip>2</Chip>} />
        </Card>
      </Section>
      <Section title="Controls">
        <div className="gallery-line">
          <Switch checked={on} onChange={setOn} label="Switch" />
          <Field placeholder={fa ? 'جستجو…' : 'Search…'} />
          <Chip color="#0f8f83" dot>{fa ? 'در حال انجام' : 'Doing'}</Chip>
        </div>
        <Tabs items={[{ id: 'one', label: fa ? 'یک' : 'One' }, { id: 'two', label: fa ? 'دو' : 'Two' }]} value={tab} onChange={setTab} />
      </Section>
      <Section title="Dialog">
        <Button onClick={() => setOpen(true)}>{fa ? 'باز کردن' : 'Open dialog'}</Button>
        <Dialog open={open} title={fa ? 'تغییر نام' : 'Rename page'} onClose={() => setOpen(false)}
          actions={<><Button onClick={() => setOpen(false)}>{fa ? 'انصراف' : 'Cancel'}</Button><Button variant="primary" onClick={() => setOpen(false)}>{fa ? 'ذخیره' : 'Save'}</Button></>}>
          <Field defaultValue={title} />
        </Dialog>
      </Section>
    </div>
  )
}

export function Gallery() {
  const [dark, setDark] = useState(false)
  const toggle = () => { const next = !dark; setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light' }
  return (
    <div className="gallery">
      <header>
        <h1>Nevis design system</h1>
        <Button onClick={toggle}>{dark ? 'Light' : 'Dark'}</Button>
      </header>
      <div className="gallery-panes"><Pane dir="ltr" /><Pane dir="rtl" /></div>
      <Section title="Scenery: the Home banner by time of day">
        <div className="gallery-scenes">
          {[6, 10, 14, 18, 23].map((hour) => { const l = landscapeFor(hour); return <div key={hour} className="gallery-scene" style={{ backgroundImage: l.css }}><span>{l.phase}</span></div> })}
        </div>
      </Section>
      <Section title="Scenery: landscape covers">
        <div className="gallery-scenes">
          {COVER_SCENES.map((s) => <div key={s.id} className="gallery-scene" style={{ backgroundImage: s.css }}><span>{s.label}</span></div>)}
        </div>
      </Section>
    </div>
  )
}
