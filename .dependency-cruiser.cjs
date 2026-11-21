// The architecture rules of M8b (docs/ROADMAP.md): the app talks to the core through its API, never through the old app's storage or sync code,
// and device settings can never reach the outbox. `pnpm check` runs this and then proves the rules are not vacuous (tools/depcheck/test.mjs).
//
// SCOPE: only `apps/web/src` (and the fixtures of the proof) are held to the first two rules. `packages/core/src/store.ts` is the NEW store
// interface and is not touched by them.
const APP = '^(apps/web/src|tools/depcheck/fixtures)/'
module.exports = {
  forbidden: [
    {
      name: 'no-old-storage-or-sync',
      comment: 'No module of the old app\'s data layer (store, repo, db, kvStore, saveWorkspace, attachments, sync, backup, conflict, vault): the app uses @nevis/core.',
      severity: 'error',
      from: { path: APP },
      to: { path: '(^|/)(store|repo|db|kvStore|saveWorkspace|attachments|websync|autobackup|vaults?|conflict|backup)(/|\\.(ts|tsx|mjs|js)$)', pathNot: '(^|/)packages/' },
    },
    {
      name: 'no-import-from-the-old-repository',
      comment: 'Nothing is imported from the old repository (a copy is made, adapted and owned here).',
      severity: 'error',
      from: { path: APP },
      to: { path: '(^|/)Nevis/spike/' },
    },
    {
      name: 'device-settings-never-reach-the-outbox',
      comment: 'Device settings (theme, font size, sidebar width...) are local to the device (ADR-0002): the module that holds them must not be able to write to the synced log.',
      severity: 'error',
      from: { path: '(^|/)deviceSettings\\.(ts|tsx)$' },
      to: { path: '(^|/)(packages/core|node_modules/@nevis/core)(/|$)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsConfig: { fileName: 'apps/web/tsconfig.json' }, enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] } },
}
