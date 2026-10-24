// Signature-based language detection for code blocks. Pure (no DOM), tested in db/test-detect.mjs.
// Each language scores points for constructs that are (almost) unique to it; the best score wins
// if it is convincing, otherwise null and the caller falls back to highlight.js.

type Sig = [RegExp, number]

const JS: Sig[] = [
  [/\b(const|let)\s+[\w{[]/, 2],
  [/=>/, 2],
  [/\bfunction\b\s*\w*\s*\(/, 2],
  [/\bconsole\.(log|error|warn)\b/, 3],
  [/\brequire\(|\bmodule\.exports\b|\bimport\s[^;\n]+\sfrom\s|\bexport\s+(default|const|function)\b/, 3],
  [/\b(document|window)\.\w+/, 2],
  [/===|!==/, 1],
  [/\basync\s+function\b|\bawait\s+\w+/, 1],
  [/\bvar\s+\w+\s*=/, 1],
  [/\.(map|filter|reduce|forEach|then)\(/, 2],
  [/\bclass\s+\w+(\s+extends\s+\w+)?\s*\{[\s\S]*\bconstructor\s*\(/, 4],
]

const SIGS: Record<string, Sig[]> = {
  php: [[/<\?php/, 6], [/\$\w+\s*=/, 1], [/\b(echo|foreach)\b/, 1], [/->\w+\(/, 1]],
  java: [
    [/\bpublic\s+(static\s+)?(final\s+)?(class|interface|enum|void|int|String|boolean)\b/, 3],
    [/System\.(out|err)\.\w+/, 5],
    [/\bimport\s+java(x)?\./, 5],
    [/@Override\b|\bextends\s+\w+|\bimplements\s+\w+/, 2],
    [/\b(String|int|boolean|double|long)\s+\w+\s*(=|;|\()/, 1],
    [/\bnew\s+[A-Z]\w*\s*\(/, 1],
    [/\b(ArrayList|HashMap|List|Map|Set)\s*<\w+(,\s*\w+)?>\s+\w+/, 3],
    [/\bnew\s+\w+\s*<>/, 3],
    [/\b(int|double|char|String)\[\]\s+\w+/, 2],
  ],
  csharp: [
    [/\busing\s+System\b/, 5],
    [/Console\.(Write|Read)\w*/, 5],
    [/\bnamespace\s+[\w.]+/, 3],
    [/\{\s*get;\s*(set;)?\s*\}/, 5],
    [/\bpublic\s+(static\s+)?(class|void|int|string)\b/, 1],
    [/\b(string|var)\s+\w+\s*=/, 1],
    [/\b(async\s+Task|await\s+\w+|LINQ|\.Select\()/, 2],
  ],
  cpp: [
    [/#include\s*<(iostream|vector|string|map|set|algorithm|memory|fstream)>/, 6],
    [/\bstd::\w+/, 4],
    [/\b(vector|unique_ptr|shared_ptr|unordered_map)\s*</, 3],
    [/\b(cout|cin|endl)\b/, 3],
    [/\busing\s+namespace\b/, 4],
    [/\btemplate\s*<|\bnullptr\b|\bauto\s+\w+\s*=/, 3],
    [/\bclass\s+\w+\s*(:\s*(public|private)\s+\w+\s*)?\{/, 1],
  ],
  c: [
    [/#include\s*<\w+\.h>/, 5],
    [/\b(printf|scanf|malloc|free|strlen|fopen)\s*\(/, 3],
    [/\bint\s+main\s*\(\s*(void|int\s+argc.*)?\s*\)/, 2],
    [/\btypedef\b|\bstruct\s+\w+\s*\{|\b(unsigned|size_t)\b/, 1],
  ],
  python: [
    [/^\s*def\s+\w+\s*\(.*\)\s*(->\s*[\w\[\], .|]+)?\s*:\s*$/m, 5],
    [/^\s*(from\s+[\w.]+\s+)?import\s+[\w., *]+\s*$/m, 2],
    [/^\s*import\s+\w+\s+as\s+\w+/m, 3],
    [/\bprint\(/, 1],
    [/^\s*(if|elif|else|for|while|try|except|finally|with|class)\b[^{};\n]*:\s*$/m, 3],
    [/\bself\b/, 2],
    [/\b(None|True|False)\b/, 2],
    [/\blambda\b|\belif\b|\bin range\(/, 2],
  ],
  javascript: JS,
  typescript: [
    ...JS,
    [/:\s*(string|number|boolean|any|void|unknown|never)\b/, 3],
    [/\binterface\s+\w+\s*(<.*>)?\s*\{/, 3],
    [/\btype\s+\w+\s*(<.*>)?\s*=/, 3],
    [/<[A-Z]\w*(\[\])?>/, 1],
    [/\benum\s+\w+|\bas\s+(const|\w+)\b|\breadonly\b|\bimplements\b/, 2],
  ],
  go: [
    [/^package\s+\w+/m, 5],
    [/\bfunc\s+(\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/, 4],
    [/\w\s*:=\s*\S/, 3],
    [/\bfmt\.\w+\(/, 4],
    [/\bgo\s+func|\bdefer\b|\bchan\b|\bgoroutine\b/, 2],
  ],
  rust: [
    [/\bfn\s+\w+\s*(<.*>)?\(/, 4],
    [/\blet\s+(mut\s+)?\w+/, 2],
    [/\b\w+!\s*[(\[]/, 3],
    [/\buse\s+std::|\bimpl\b|\bpub\s+(fn|struct|enum)|\bmatch\s+\w+\s*\{|&mut\b|->\s*[\w<>&]+\s*\{/, 3],
  ],
  kotlin: [
    [/\bfun\s+\w+\s*\(/, 5],
    [/\b(val|var)\s+\w+\s*(:\s*[\w<>?]+)?\s*=/, 2],
    [/\bprintln\(/, 1],
    [/\bwhen\s*(\(.*\))?\s*\{|\bdata\s+class\b|\bcompanion\s+object\b|\bobject\s+\w+/, 3],
  ],
  swift: [
    [/\bimport\s+(Foundation|UIKit|SwiftUI)\b/, 6],
    [/\bfunc\s+\w+\s*\(.*\)\s*(->\s*[\w\[\]?]+)?\s*\{/, 3],
    [/\b(let|var)\s+\w+\s*:\s*[A-Z]\w*/, 1],
    [/\bguard\b|\bif\s+let\b|\bstruct\s+\w+\s*:\s*\w+/, 3],
  ],
  ruby: [
    [/^\s*def\s+\w+[?!]?(\(.*\))?\s*$/m, 2],
    [/^\s*end\s*$/m, 4],
    [/\bputs\b|\battr_(reader|accessor|writer)\b|\brequire\s+['"]/, 4],
    [/\|\w+(,\s*\w+)*\|/, 2],
    [/\bdo\s*(\|.*\|)?\s*$/m, 2],
  ],
  sql: [
    [/\bSELECT\b[\s\S]*?\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bCREATE\s+(TABLE|INDEX|VIEW|DATABASE)\b|\bALTER\s+TABLE\b|\bDROP\s+TABLE\b/i, 7],
    [/\b(WHERE|GROUP\s+BY|ORDER\s+BY|JOIN|VALUES|LIMIT|HAVING)\b/i, 1],
  ],
  bash: [
    [/^#!.*\b(ba|z)?sh\b/m, 6],
    [/^\s*(sudo|apt(-get)?|npm|npx|git|cd|ls|echo|export|chmod|curl|wget|pip|docker|mkdir|rm|cat|grep)\b/m, 3],
    [/^\s*\$\s+\S/m, 3],
    [/\b(then|fi|done|esac)\b|\bfor\s+\w+\s+in\b/, 2],
    [/\$\{?\w+\}?/, 1],
  ],
  xml: [
    [/^\s*<!DOCTYPE\s+html/i, 7],
    [/^\s*<\?xml/, 7],
    [/^\s*<([a-z][\w:-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/i, 5],
    [/<\/?(div|span|p|html|body|head|ul|li|a|script|style|h[1-6]|table|tr|td|form|input|button)\b/i, 2],
  ],
  css: [
    [/(^|\})\s*[.#@]?[\w-][\w\s.#:>+~,*[\]="'()-]*\{[^{}]*:[^{}]*\}/m, 5],
    [/\b(color|margin|padding|display|font-size|font-family|background(-color)?|border(-radius)?|width|height)\s*:/, 2],
    [/@media\b|@import\b|@keyframes\b|@font-face\b/, 3],
  ],
  diff: [[/^@@ .* @@/m, 6], [/^(\+\+\+|---) \S/m, 4], [/^[+-]\s*\S.*\n[+-]\s*\S/m, 1]],
}

const ORDER = Object.keys(SIGS)

function isJson(code: string) {
  const t = code.trim()
  if (!/^[{[]/.test(t)) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

function looksYaml(code: string) {
  const lines = code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (lines.length < 2 || /[{};()]/.test(code.replace(/"[^"]*"|'[^']*'/g, ''))) return false
  const ok = lines.filter((l) => /^\s*[\w.-]+:(\s+\S.*)?$/.test(l) || /^\s*-\s+\S/.test(l)).length
  return ok / lines.length >= 0.8 && lines.some((l) => /^\s*[\w.-]+:/.test(l))
}

export function detectLanguage(code: string): string | null {
  const text = code.trim()
  if (text.length < 3) return null
  if (isJson(text)) return 'json'
  if (looksYaml(text)) return 'yaml'

  const scores = ORDER.map((id) => [id, SIGS[id].reduce((s, [re, pts]) => s + (re.test(text) ? pts : 0), 0)] as const)
  // Python and Ruby both use `def`, but only Python blocks end with a colon; semicolon/brace code is never Python.
  const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a))
  return best[1] >= 3 ? best[0] : null
}
