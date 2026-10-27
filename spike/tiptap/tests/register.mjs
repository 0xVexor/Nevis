// Small test-only loader: resolve Vite-style extensionless TS imports without changing production imports.
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL)
      // Structural tests do not mount the application's global settings or confirmation UI.
      if (url.pathname.endsWith('/src/i18n')) return { url: 'nevis-test:i18n', shortCircuit: true }
      if (url.pathname.endsWith('/src/dialog')) return { url: 'nevis-test:dialog', shortCircuit: true }
      for (const suffix of ['.ts', '.tsx']) if (existsSync(fileURLToPath(url) + suffix)) return { url: url.href + suffix, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'nevis-test:i18n') return { format: 'module', shortCircuit: true, source: "export const t = (s, vars) => s.replace(/\\{(\\w+)\\}/g, (_, k) => String(vars?.[k] ?? ''))" }
    if (url === 'nevis-test:dialog') return { format: 'module', shortCircuit: true, source: "export const confirmDialog = async () => { throw new Error('Unexpected UI confirmation in structural tests') }" }
    if (/\.tsx?$/.test(url)) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX } }).outputText, shortCircuit: true }
    return next(url, context)
  },
})
