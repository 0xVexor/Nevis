import { useState } from 'react'
import { Button, IconButton } from './Button'
import { Card, Chip, ChipButton, Facts, Field, Notice, PropertyList, PropertyRow, Section, Switch, Tabs, Tag } from './controls'
import { IconPicker } from './IconPicker'
import { BACKGROUNDS } from './backgrounds'
import { Row } from './Row'
import { Dialog, Tooltip } from './overlay'
import { Icon } from './icons'
import { COVER_SCENES, landscapeFor } from './scenery'
import { PreferenceGroup, PreferenceRow, SegmentedChoice, RangeControl } from './Preferences'
import { WorkspaceHeader } from './WorkspaceHeader'
import { CommandDialog, CommandResult } from './CommandDialog'
import { SaveStatus } from './SaveStatus'
import { BrandMark } from '../BrandMark'
import './gallery.css'

/**
 * The component gallery (development only: open /#/design-system). Every component in left-to-right and right-to-left,
 * so a change can be checked in both directions at a glance; the theme button flips light and dark.
 */
function Pane({ dir }: { dir: 'ltr' | 'rtl' }) {
  const [on, setOn] = useState(true)
  const [tab, setTab] = useState('one')
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState(16)
  const [commandOpen, setCommandOpen] = useState(false)
  const [fav, setFav] = useState(true)
  const [tags, setTags] = useState(['study', 'notes', 'java'])
  const [glyph, setGlyph] = useState<{ name?: string; color?: string }>({ name: 'book' })
  const [cover, setCover] = useState('sky-mist')
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
          <Button size="sm" icon={<Icon name="plus" size={14} />}>
            {fa ? 'جدید' : 'New'}
          </Button>
          <Tooltip label={fa ? 'افزودن' : 'Add'}>
            <IconButton label={fa ? 'افزودن' : 'Add'}>
              <Icon name="plus" />
            </IconButton>
          </Tooltip>
        </div>
      </Section>
      <Section title="Row: the icon follows the text">
        <Card className="gallery-card">
          <Row icon={<Icon name="home" />} text={title} />
          <Row icon={<Icon name="home" />} text="Java lecture notes" />
          <Row icon={<Icon name="home" />} text="فصل ۱۵ — Graph" trailing={<Chip>2</Chip>} />
        </Card>
      </Section>
      <Section title="Search and commands">
        <Button onClick={() => setCommandOpen(true)}>Open command surface</Button>
        {commandOpen && <CommandDialog dir={dir} label="Search" onClose={() => setCommandOpen(false)} header={<input aria-label="Search" placeholder="Search the workspace" />} filters={<span>All / Pages / Commands</span>} footer={<span>Esc: close</span>}>
          <CommandResult icon={<Icon name="file" />} selected trailing={<kbd>Enter</kbd>} onClick={() => setCommandOpen(false)}><b>Reading notes</b><small>Search result with a content passage</small></CommandResult>
          <CommandResult icon={<Icon name="plus" />} onClick={() => setCommandOpen(false)}><b>Create a page</b></CommandResult>
        </CommandDialog>}
      </Section>
      <Section title="Workspace identity">
        <WorkspaceHeader mark={<BrandMark />} name="Nevis" revealLabel="Open sidebar" expanded={on} onReveal={() => setOn(true)} action={<IconButton label="Close sidebar" onClick={() => setOn(false)}><Icon name="panel-left" /></IconButton>} />
      </Section>
      <Section title="Save feedback">
        <div className="gallery-line"><SaveStatus state="saving" label={fa ? 'در حال ذخیره…' : 'Saving…'} /><SaveStatus state="saved" label={fa ? 'تغییرات ذخیره شد' : 'All changes saved'} /><SaveStatus state="error" label={fa ? 'ذخیره نشد' : 'Could not save'} /></div>
      </Section>
      <Section title="Preferences patterns">
        <PreferenceGroup title={fa ? 'ترجیحات' : 'Preferences'}>
          <PreferenceRow label={fa ? 'حرکت' : 'Motion'}><Switch checked={on} onChange={setOn} label="Motion" /></PreferenceRow>
          <PreferenceRow label={fa ? 'اندازهٔ متن' : 'Text size'}><RangeControl label="Text size" value={size} min={13} max={22} onChange={setSize} /></PreferenceRow>
          <PreferenceRow label={fa ? 'انتخاب' : 'Choice'}><SegmentedChoice label="Choice" value={tab} onChange={setTab} items={[{value:'one',label:'One'},{value:'two',label:'Two'}]} /></PreferenceRow>
        </PreferenceGroup>
      </Section>
      <Section title="Controls">
        <div className="gallery-line">
          <Switch checked={on} onChange={setOn} label="Switch" />
          <Field placeholder={fa ? 'جستجو…' : 'Search…'} />
          <Chip color="#0f8f83" dot>
            {fa ? 'در حال انجام' : 'Doing'}
          </Chip>
        </div>
        <Tabs
          items={[
            { id: 'one', label: fa ? 'یک' : 'One' },
            { id: 'two', label: fa ? 'دو' : 'Two' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </Section>
      <Section title="Properties, chips and tags">
        <PropertyList label={fa ? 'ویژگی‌های صفحه' : 'Page properties'}>
          <PropertyRow icon={<Icon name="flag" size={16} />} label={fa ? 'وضعیت' : 'Status'}>
            <ChipButton icon={<i className="ds-menu-dot" style={{ background: '#f59e0b' }} />}>
              <span>{fa ? 'در حال انجام' : 'In progress'}</span>
              <Icon name="chevron-down" size={14} />
            </ChipButton>
          </PropertyRow>
          <PropertyRow icon={<Icon name="tag" size={16} />} label={fa ? 'برچسب‌ها' : 'Tags'}>
            {tags.map((tag) => (
              <Tag key={tag} label={tag} onOpen={() => undefined} openLabel="Show pages with this tag" onRemove={() => setTags(tags.filter((x) => x !== tag))} removeLabel={fa ? 'حذف برچسب' : 'Remove tag'} />
            ))}
            <ChipButton empty icon={<Icon name="plus" size={14} />} onClick={() => setTags([...tags, 'tag ' + (tags.length + 1)])}>
              {fa ? 'افزودن برچسب…' : 'Add tag…'}
            </ChipButton>
          </PropertyRow>
          <PropertyRow icon={<Icon name="clock" size={16} />} label={fa ? 'آخرین ویرایش' : 'Last edited'}>
            {fa ? '۵ دقیقه پیش' : '5 minutes ago'}
          </PropertyRow>
        </PropertyList>
        <IconButton className="ds-icon-btn--toggle" label={fa ? 'علاقه‌مندی' : 'Favourite'} pressed={fav} onClick={() => setFav(!fav)}>
          <Icon name="star" size={18} />
        </IconButton>
      </Section>
      <Section title="Covers and colours">
        <div className="ds-swatches">
          {BACKGROUNDS.filter((b) => b.group === 'soft').map((b) => (
            <button key={b.id} type="button" className="ds-swatch" aria-label={b.label} aria-pressed={cover === b.id} style={{ background: b.css }} onClick={() => setCover(b.id)} />
          ))}
        </div>
        <input className="ds-color" type="color" defaultValue="#6a5cff" aria-label={fa ? 'رنگ دلخواه' : 'Your own color'} />
      </Section>
      <Section title="Icon picker">
        <div className="ds-pop">
          <IconPicker name={glyph.name} color={glyph.color} onPick={(name, color) => setGlyph({ name, color })} onClear={() => setGlyph({})} />
        </div>
      </Section>
      <Section title="Facts and notice">
        <Facts
          items={[
            [fa ? 'صفحه‌ها' : 'Pages', fa ? '۱۲۸' : '128'],
            [fa ? 'تصویرها' : 'Images', fa ? '۴۲' : '42'],
          ]}
        />
        <Notice tone="warn" icon={<Icon name="warning" size={16} />}>
          {fa ? 'همهٔ صفحه‌های فعلی جایگزین می‌شوند.' : 'All current pages will be replaced.'}
        </Notice>
      </Section>
      <Section title="Stack">
        <div className="ds-stack">
          <div className="ds-seg" role="radiogroup" aria-label="Choice">
            <button type="button" role="radio" aria-checked aria-pressed>
              {fa ? 'جدید' : 'New'}
            </button>
            <button type="button" role="radio" aria-checked={false} aria-pressed={false}>
              {fa ? 'همین' : 'Here'}
            </button>
          </div>
          <Field placeholder={fa ? 'نام' : 'Name'} />
          <Notice icon={<Icon name="info" size={16} />}>{fa ? 'یک جمله که باید دیده شود.' : 'One sentence that must be seen.'}</Notice>
        </div>
      </Section>
      <Section title="Dialog">
        <Button onClick={() => setOpen(true)}>{fa ? 'باز کردن' : 'Open dialog'}</Button>
        <Dialog
          open={open}
          title={fa ? 'تغییر نام' : 'Rename page'}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>{fa ? 'انصراف' : 'Cancel'}</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                {fa ? 'ذخیره' : 'Save'}
              </Button>
            </>
          }
        >
          <Field defaultValue={title} />
        </Dialog>
      </Section>
    </div>
  )
}

export function Gallery() {
  const [dark, setDark] = useState(false)
  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.dataset.theme = next ? 'dark' : 'light'
  }
  return (
    <div className="gallery">
      <header>
        <h1>Nevis design system</h1>
        <Button onClick={toggle}>{dark ? 'Light' : 'Dark'}</Button>
      </header>
      <div className="gallery-panes">
        <Pane dir="ltr" />
        <Pane dir="rtl" />
      </div>
      <Section title="Scenery: the Home banner by time of day">
        <div className="gallery-scenes">
          {[6, 10, 14, 18, 23].map((hour) => {
            const l = landscapeFor(hour)
            return (
              <div key={hour} className="gallery-scene" style={{ backgroundImage: l.css }}>
                <span>{l.phase}</span>
              </div>
            )
          })}
        </div>
      </Section>
      <Section title="Scenery: landscape covers">
        <div className="gallery-scenes">
          {COVER_SCENES.map((s) => (
            <div key={s.id} className="gallery-scene" style={{ backgroundImage: s.css }}>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}
