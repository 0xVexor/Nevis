// The app loads the document store before the editor modules; the editor's page links read it during module setup.
import '../../store'
import { createRoot } from 'react-dom/client'
import { useMemo, useState } from 'react'
import { ConflictBanner } from '../../conflict/ConflictBanner'
import { ConflictView } from '../../conflict/ConflictView'
import { Button } from '../../design-system'
import { updateSettings } from '../../settings'
import { t } from '../../i18n'
import { cases } from './fixtures'
import '../../index.css'
import './preview.css'

// Isolated review of the conflict screen with fake data; nothing is read or saved.
// ?lang=fa for Persian (right-to-left), ?big=1 adds a 300-block page, ?theme=dark, ?case=paragraph opens that case.
const query = new URLSearchParams(location.search)
const lang = query.get('lang') === 'fa' ? 'fa' : 'en'
updateSettings({ lang, dir: 'auto', theme: query.get('theme') === 'dark' ? 'dark' : 'light', accent: query.get('accent'), reduceMotion: query.has('reduced') })
document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr'
document.documentElement.lang = lang

function Preview() {
  const all = useMemo(() => cases(lang, query.has('big')), [])
  const [current, setCurrent] = useState(all.find((c) => c.id === (query.get('case') ?? (query.has('big') ? 'big' : ''))) ?? all[0])
  const [mode, setMode] = useState<'page' | 'review'>('page')
  const [dismissed, setDismissed] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const pick = (id: string) => {
    setCurrent(all.find((c) => c.id === id)!)
    setMode('page')
    setDismissed(false)
    setResult(null)
  }

  return (
    <div className="cfp">
      <nav className="cfp-cases" aria-label="Cases">
        {all.map((c) => (
          <Button key={c.id} size="sm" variant={c.id === current.id ? 'primary' : 'default'} onClick={() => pick(c.id)}>
            {c.label}
          </Button>
        ))}
      </nav>
      <main className="cfp-page">
        {mode === 'review' ? (
          <ConflictView
            key={current.id}
            marker={current.marker}
            onApply={async (content, title) => {
              await new Promise((resolve) => setTimeout(resolve, 300))
              setResult(JSON.stringify({ title, content }, null, 2))
              setMode('page')
              setDismissed(true)
            }}
            onCancel={() => setMode('page')}
          />
        ) : (
          <div className="cfp-doc">
            {!dismissed && <ConflictBanner markers={[current.marker]} onReview={() => setMode('review')} onKeepCurrent={() => setDismissed(true)} />}
            <h1 dir="auto">{current.marker[current.marker.kept].page.title}</h1>
            <p className="cfp-note">{dismissed && !result ? t('Kept the current version.') : ''}</p>
            {result && <pre className="cfp-result" dir="ltr" aria-label="Applied result">{result}</pre>}
          </div>
        )}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
