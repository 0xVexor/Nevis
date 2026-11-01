import { useEffect, useState, type DragEvent } from 'react'
import { backupNow, backupStatus, chooseBackupFolder, disableBackup, grantAccess } from './autobackup'
import { BackupError, restoreBackup } from './backup'
import { isTauri } from './db'
import { Button, Chip, Dialog, Facts, Icon, Notice } from './design-system'
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

  const look = async (files: File[]) => {
    if (!files.length) return
    setReading(true)
    try {
      setPhase({ step: 'review', review: await reviewImport(files) })
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
        await restoreBackup(api.repo, review.backup!) // reloads the app when it is done
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
          </span>
        </div>
      </Card>

      <Card title={t('Export and backup')}>
        <Row label={t('Export to read or move')} hint={t('A zip of Markdown files and images. You can import it back above.')}>
          <Button size="sm" icon={<Ic.Download size={15} />} onClick={api.exportAll}>{t('Export')}</Button>
        </Row>
        <Row label={t('Full backup')} hint={t('Everything in one file: pages, databases, settings and history. Restore it above.')}>
          <Button size="sm" icon={<Ic.Download size={15} />} onClick={api.backup}>{t('Back up')}</Button>
        </Row>
      </Card>

      <AutoBackup />

      <Card title={t('Workspaces')}>
        <Row label={t('Workspaces')} hint={t('Switch or create a workspace')}>
          <Button size="sm" onClick={api.workspaces}>{t('Open')}</Button>
        </Row>
      </Card>

      <ImportDialog phase={phase} api={api} go={go} close={() => setPhase(null)} />
    </>
  )
}

function ImportDialog({ phase, api, go, close }: { phase: Phase | null; api: DataApi; go: () => void; close: () => void }) {
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
      {isBackup && isTauri && <Notice icon={<Icon name="info" size={16} />}>{t('The backup opens as a new workspace. Your current notes stay as they are.')}</Notice>}
      {!isBackup && <Notice icon={<Icon name="info" size={16} />}>{t('These are added as new pages. Nothing you have is replaced.')}</Notice>}
      {skipped.length > 0 && <Notice icon={<Icon name="info" size={16} />}>{t('Left out: {list}.', { list: skipped.map(([ext, n]) => `${num(n)} ${ext}`).join('، ') })}</Notice>}
      {review.notes.length > 0 && <Notice tone="warn" icon={warn}><ul>{review.notes.slice(0, 5).map((n) => <li key={n} dir="auto">{n}</li>)}</ul></Notice>}
      {blocked && <Notice tone="bad" icon={warn}><ul>{review.problems.map((p) => <li key={p.name} dir="auto">{p.name}: {p.reason}</li>)}</ul></Notice>}
    </Dialog>
  )
}

function AutoBackup() {
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

  if (!st.supported) {
    return (
      <Card title={t('Automatic backup')}>
        <Notice tone="warn" icon={<Icon name="warning" size={16} />}>{t('This browser does not support folder selection. Use Edge or Chrome; until then, manual “Full backup” still works.')}</Notice>
      </Card>
    )
  }
  const needs = st.error === 'NEEDS_PERMISSION'
  const status = !st.enabled
    ? <Chip dot>{t('Off')}</Chip>
    : needs ? <Chip dot color="var(--ds-warn)">{t('Needs access permission')}</Chip>
    : st.error ? <Chip dot color="var(--ds-bad)">{t('Error')}</Chip>
    : <Chip dot color="var(--ds-ok)">{t('On')}</Chip>

  return (
    <Card title={t('Automatic backup')} hint={t('A full copy of all pages and images in a folder you choose.')}>
      <Row label={t('Status')} hint={st.enabled ? t('Updated as you work, and once a day. The last {days} days are kept.', { days: 14 }) : undefined}>
        {status}
        {!st.enabled || !st.folder
          ? <Button size="sm" variant="primary" disabled={busy} onClick={() => run(chooseBackupFolder)}>{t('Choose folder and turn on')}</Button>
          : needs && <Button size="sm" variant="primary" disabled={busy} onClick={() => run(grantAccess)}>{t('Grant access')}</Button>}
      </Row>
      {st.enabled && st.folder && (
        <>
          <Row label={t('Folder')}>
            <span dir="auto">{st.folder}</span>
            <Button size="sm" disabled={busy} onClick={() => run(chooseBackupFolder)}>{t('Change folder')}</Button>
          </Row>
          <Row label={t('Last backup')}>
            <span>{when(st.lastAt)}</span>
            <Button size="sm" disabled={busy} onClick={() => run(backupNow)}>{t('Back up now')}</Button>
          </Row>
          <Row label={t('Turn off')} hint={t('Stops saving copies. The files already in the folder stay.')}>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => run(disableBackup)}>{t('Turn off')}</Button>
          </Row>
        </>
      )}
      {st.error && !needs && <Notice tone="bad" icon={<Icon name="warning" size={16} />}>{st.error}</Notice>}
      {needs && <Notice tone="warn" icon={<Icon name="warning" size={16} />}>{t('After closing the browser, folder access must be granted again.')}</Notice>}
    </Card>
  )
}
