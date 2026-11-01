import { useEffect, useState, type DragEvent } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { backupNow, backupStatus, chooseBackupFolder, grantAccess, setAutomatic } from './autobackup'
import { BackupError, readFolder, restoreBackup } from './backup'
import { isTauri } from './db'
import { Button, Dialog, Facts, Field, Icon, Notice, Section, Switch } from './design-system'
import { locale, t } from './i18n'
import * as Ic from './icons'
import { pickDirectory, pickFiles } from './io'
import { reviewImport, runImport, type ImportOutcome, type ImportReview } from './importPlan'
import type { PageRepo } from './repo'
import { Card, Row } from './SettingsParts'

export interface DataApi {
  repo: PageRepo
  refresh: () => void
  toast: (msg: string) => void
  open: (id: string) => void
  exportAll: () => void
  backup: () => void
  workspaces: () => void
}

/** Where a desktop backup goes: a new workspace with this name, or into the open one. */
interface Where { target: 'new' | 'merge' | 'here'; name: string }

type Phase =
  | { step: 'review'; review: ImportReview }
  | { step: 'running'; review: ImportReview; done: number; total: number }
  | { step: 'done'; review: ImportReview; outcome: ImportOutcome }
  | { step: 'error'; message: string }

const num = (n: number) => n.toLocaleString(locale())
const when = (ts?: number) => (ts ? new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : t('Not yet'))
const size = (bytes: number) => (bytes < 1024 * 1024 ? t('{n} KB', { n: num(Math.max(1, Math.round(bytes / 1024))) }) : t('{n} MB', { n: num(Math.round(bytes / 1024 / 1024)) }))

export function DataTab({ api }: { api: DataApi }) {
  const [phase, setPhase] = useState<Phase | null>(null)
  const [reading, setReading] = useState(false)
  const [over, setOver] = useState(false)
  const [where, setWhere] = useState<Where>({ target: 'merge', name: '' })

  const look = async (files: File[]) => {
    if (!files.length) return
    setReading(true)
    try {
      const review = await reviewImport(files)
      // a backup is called what its workspace was called
      if (review.kind === 'backup') setWhere({ target: 'merge', name: review.backup?.summary.name ?? review.name.replace(/\.json$/i, '') })
      setPhase({ step: 'review', review })
    } catch (e) {
      setPhase({ step: 'error', message: e instanceof BackupError ? e.message : t('The file could not be read.') })
    } finally {
      setReading(false)
    }
  }
  /** A backup folder (the workspace's own folder inside the backup folder): checked here, restored only after the review. */
  const chooseBackupToRestore = async () => {
    const dir = await openDialog({ directory: true })
    if (typeof dir !== 'string') return
    setReading(true)
    try {
      const backup = await readFolder(dir)
      setWhere({ target: 'merge', name: backup.summary.name ?? '' })
      setPhase({ step: 'review', review: { kind: 'backup', name: dir.split(/[\\/]/).pop() || dir, pages: backup.summary.pages, folders: backup.summary.folders, images: backup.summary.files, skipped: {}, notes: [], problems: [], files: [], backup } })
    } catch (e) {
      setPhase({ step: 'error', message: e instanceof BackupError ? e.message : t('The file could not be read.') })
    } finally {
      setReading(false)
    }
  }
  const chooseFiles = async () => look(await pickFiles('.md,.markdown,.txt,.zip,.json', true))
  const chooseFolder = async () => look(await pickDirectory())
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void look([...e.dataTransfer.files])
  }

  const go = async () => {
    if (phase?.step !== 'review') return
    const { review } = phase
    setPhase({ step: 'running', review, done: 0, total: review.pages })
    try {
      if (review.kind === 'backup') {
        await restoreBackup(api.repo, review.backup!, isTauri ? where : {}) // reloads the app when it is done
        return
      }
      const outcome = await runImport(review, (done, total) => setPhase({ step: 'running', review, done, total }))
      api.refresh()
      setPhase({ step: 'done', review, outcome })
    } catch (e) {
      api.refresh()
      setPhase({ step: 'error', message: e instanceof BackupError ? e.message : t('Something went wrong. Nothing was changed.') })
    }
  }

  return (
    <>
      <Card title={t('Import or restore')} hint={t('Bring in Markdown files, an Obsidian folder, a zip you exported, or a full backup.')}>
        <div className="sx-drop" data-over={over} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={drop}>
          <span className="sx-drop-ic"><Ic.Upload size={22} /></span>
          <b>{t('Drop files here')}</b>
          <small>{t('Markdown, zip or a backup file. Nothing is changed until you confirm.')}</small>
          <span className="sx-drop-btns">
            <Button size="sm" disabled={reading} onClick={chooseFiles}>{t('Choose files…')}</Button>
            <Button size="sm" disabled={reading} onClick={chooseFolder}>{t('Choose a folder…')}</Button>
            {isTauri && <Button size="sm" disabled={reading} onClick={chooseBackupToRestore}>{t('Restore from a backup folder…')}</Button>}
          </span>
        </div>
      </Card>

      <BackupCard api={api} />

      <Card title={t('Export to read or move')} hint={t('A zip of Markdown files and images, for reading or for other apps. It is not a backup: databases, history and settings are not in it.')}>
        <Row label={t('Markdown zip')} hint={t('You can import it back above.')}>
          <Button size="sm" icon={<Ic.Download size={15} />} onClick={api.exportAll}>{t('Export')}</Button>
        </Row>
      </Card>

      <Card title={t('Workspaces')}>
        <Row label={t('Workspaces')} hint={t('Switch or create a workspace')}>
          <Button size="sm" onClick={api.workspaces}>{t('Open')}</Button>
        </Row>
      </Card>

      <ImportDialog phase={phase} api={api} go={go} close={() => setPhase(null)} where={where} setWhere={setWhere} />
    </>
  )
}

function ImportDialog({ phase, api, go, close, where, setWhere }: { phase: Phase | null; api: DataApi; go: () => void; close: () => void; where: Where; setWhere: (w: Where) => void }) {
  if (!phase) return null
  const warn = <Icon name="warning" size={16} />

  if (phase.step === 'error') {
    return (
      <Dialog open title={t('Nothing was imported')} onClose={close} actions={<Button variant="primary" onClick={close}>{t('Close')}</Button>}>
        <Notice tone="bad" icon={warn}>{phase.message}</Notice>
      </Dialog>
    )
  }

  const { review } = phase
  const isBackup = review.kind === 'backup'

  if (phase.step === 'running') {
    const pct = isBackup || !phase.total ? undefined : Math.round((phase.done / phase.total) * 100)
    return (
      <Dialog open title={isBackup ? t('Restoring…') : t('Importing…')} onClose={() => {}}>
        <span className="ds-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i style={{ inlineSize: (pct ?? 100) + '%' }} />
        </span>
        <p className="sx-note">{pct === undefined ? t('Please keep this window open.') : t('{done} of {total} pages', { done: num(phase.done), total: num(phase.total) })}</p>
      </Dialog>
    )
  }

  if (phase.step === 'done') {
    const { outcome } = phase
    return (
      <Dialog
        open
        title={outcome.errors.length ? t('Imported, with problems') : t('Imported')}
        onClose={close}
        actions={<>
          <Button onClick={close}>{t('Close')}</Button>
          {outcome.first && <Button variant="primary" onClick={() => (close(), api.open(outcome.first!))}>{t('Open')}</Button>}
        </>}
      >
        <Facts items={[
          [t('Pages'), num(outcome.pages)],
          ...(outcome.folders ? [[t('Folders'), num(outcome.folders)] as [string, string]] : []),
          ...(outcome.images ? [[t('Images'), num(outcome.images)] as [string, string]] : []),
        ]} />
        {outcome.errors.length > 0 && (
          <Notice tone="warn" icon={warn}>
            {t('{n} files could not be imported:', { n: num(outcome.errors.length) })}
            <ul>{outcome.errors.map((e) => <li key={e.name} dir="auto">{e.name}: {e.reason}</li>)}</ul>
          </Notice>
        )}
      </Dialog>
    )
  }

  const replaces = isBackup && !isTauri
  const blocked = review.problems.length > 0
  const skipped = Object.entries(review.skipped)
  const current = api.repo.pagesOnly().length
  const b = review.backup?.summary
  return (
    <Dialog
      open
      title={isBackup ? t('Restore from backup') : t('Import')}
      onClose={close}
      actions={<>
        <Button onClick={close}>{t('Cancel')}</Button>
        <Button variant={replaces ? 'danger' : 'primary'} disabled={blocked} onClick={go}>{isBackup ? t('Restore') : t('Import')}</Button>
      </>}
    >
      <Facts items={b ? [
        [t('File'), review.name],
        ...(b.name ? [[t('Workspace'), b.name] as [string, string]] : []),
        ...(b.createdAt ? [[t('Created'), when(b.createdAt)] as [string, string]] : []),
        [t('Pages'), num(b.pages)],
        ...(b.folders ? [[t('Folders'), num(b.folders)] as [string, string]] : []),
        ...(b.trashed ? [[t('In trash'), num(b.trashed)] as [string, string]] : []),
        [t('Images and files'), num(b.files)],
        [t('Size'), size(b.bytes)],
      ] : [
        [t('From'), review.name],
        [t('Pages'), num(review.pages)],
        ...(review.folders ? [[t('Folders'), num(review.folders)] as [string, string]] : []),
        ...(review.images ? [[t('Images'), num(review.images)] as [string, string]] : []),
      ]} />
      {replaces && <Notice tone="warn" icon={warn}>{t('All {n} pages you have now will be replaced. A copy of them is saved to your downloads first.', { n: num(current) })}</Notice>}
      {isBackup && isTauri && (
        <Section title={t('Restore into')}>
          <div className="ds-stack">
            <div className="ds-seg" role="radiogroup" aria-label={t('Restore into')}>
              {(['merge', 'new', 'here'] as const).map((target) => (
                <button key={target} type="button" role="radio" aria-checked={where.target === target} aria-pressed={where.target === target} onClick={() => setWhere({ ...where, target })}>
                  {target === 'merge' ? t('Merge into this workspace') : target === 'new' ? t('A new workspace') : t('Replace in this workspace')}
                </button>
              ))}
            </div>
            {where.target === 'merge' ? (
              <Notice icon={<Icon name="info" size={16} />}>{t('Pages that are not here are added. A page in both keeps its newer version, and the older one goes to the page history. Nothing is deleted, and pages in your trash stay there. A copy of this workspace is saved next to it first.')}</Notice>
            ) : where.target === 'new' ? (
              <>
                <Field aria-label={t('Workspace name')} value={where.name} onChange={(e) => setWhere({ ...where, name: e.target.value })} />
                <Notice icon={<Icon name="info" size={16} />}>{t('Opens next to your current one. Nothing you have is changed.')}</Notice>
              </>
            ) : (
              <Notice tone="warn" icon={warn}>{t("Pages, files, databases and history from the backup are written into this workspace. A page in both is replaced by the backup's version; nothing is deleted. A copy of this workspace is saved next to it first.")}</Notice>
            )}
          </div>
        </Section>
      )}
      {!isBackup && <Notice icon={<Icon name="info" size={16} />}>{t('These are added as new pages. Nothing you have is replaced.')}</Notice>}
      {skipped.length > 0 && <Notice icon={<Icon name="info" size={16} />}>{t('Left out: {list}.', { list: skipped.map(([ext, n]) => `${num(n)} ${ext}`).join('، ') })}</Notice>}
      {review.notes.length > 0 && <Notice tone="warn" icon={warn}><ul>{review.notes.slice(0, 5).map((n) => <li key={n} dir="auto">{n}</li>)}</ul></Notice>}
      {blocked && <Notice tone="bad" icon={warn}><ul>{review.problems.map((p) => <li key={p.name} dir="auto">{p.name}: {p.reason}</li>)}</ul></Notice>}
    </Dialog>
  )
}

/** One backup, one place: where it goes, when it was last taken, take one now, and whether it happens by itself. */
function BackupCard({ api }: { api: DataApi }) {
  const [st, setSt] = useState(backupStatus())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const h = () => setSt(backupStatus())
    window.addEventListener('backup-status', h)
    return () => window.removeEventListener('backup-status', h)
  }, [])
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await f()
    } finally {
      setBusy(false)
      setSt(backupStatus())
    }
  }
  const warn = <Icon name="warning" size={16} />
  const needs = st.error === 'NEEDS_PERMISSION'
  const c = st.counts

  return (
    <Card title={t('Backup')} hint={t('A copy of everything: pages, folders, images, databases, settings and history. Restore it above.')}>
      {!st.supported ? (
        <Notice tone="warn" icon={warn}>{t('This browser does not support folder selection. Use Edge or Chrome; until then, manual “Full backup” still works.')}</Notice>
      ) : (
        <>
          <Row label={t('Backup folder')} hint={st.ready ? undefined : t('Choose where backups are kept.')}>
            {st.folder && <span dir="auto">{st.folder}</span>}
            <Button size="sm" variant={st.ready ? undefined : 'primary'} disabled={busy} onClick={() => run(chooseBackupFolder)}>{st.ready ? t('Change folder') : t('Choose folder')}</Button>
            {needs && <Button size="sm" variant="primary" disabled={busy} onClick={() => run(grantAccess)}>{t('Grant access')}</Button>}
          </Row>
          {st.ready && (
            <>
              <Row label={t('Last backup')} hint={c ? t('{pages} pages, {folders} folders, {files} images and files', { pages: num(c.pages - c.trashed), folders: num(c.folders), files: num(c.files) }) : undefined}>
                <span>{when(st.lastAt)}</span>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => backupNow())}>{t('Back up now')}</Button>
              </Row>
              <Row label={t('Automatic')} hint={t('Backs up as you work and when you leave.')}>
                <Switch label={t('Automatic')} checked={st.enabled} disabled={busy} onChange={(on) => run(() => setAutomatic(on))} />
              </Row>
            </>
          )}
          {st.blocked && (
            <Notice tone="warn" icon={warn}>
              {st.error}
              <Button size="sm" disabled={busy} onClick={() => run(() => backupNow(true))}>{t('Back up anyway')}</Button>
            </Notice>
          )}
          {st.error && !needs && !st.blocked && <Notice tone="bad" icon={warn}>{st.error}</Notice>}
          {needs && <Notice tone="warn" icon={warn}>{t('After closing the browser, folder access must be granted again.')}</Notice>}
        </>
      )}
      <Row label={t('Backup as one file')} hint={t('The same backup in a single file, to keep or move.')}>
        <Button size="sm" icon={<Ic.Download size={15} />} onClick={api.backup}>{t('Back up')}</Button>
      </Row>
    </Card>
  )
}
