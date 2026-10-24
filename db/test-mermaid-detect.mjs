// Which pasted text counts as Mermaid source, and how typographic characters are repaired (src/editor/mermaidText.ts).
import assert from 'node:assert/strict'

const { looksLikeMermaid, cleanMermaid } = await import('../spike/tiptap/src/editor/mermaidText.ts')

const yes = [
  'flowchart LR\n  A --> B',
  'graph TD\n  A[Start] --> B{Ok?}',
  'graph\n  A --> B',
  'sequenceDiagram\n  Alice->>Bob: hi',
  'classDiagram\n  Animal <|-- Dog',
  'stateDiagram-v2\n  [*] --> Still',
  'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  'pie\n  "Dogs" : 5',
  'gantt\n  title Plan\n  section A',
  'journey\n  title My day\n  section Work',
  'timeline\n  title History\n  2002 : LinkedIn',
  'mindmap\n  root((idea))\n    child',
  'gitGraph\n  commit\n  branch dev',
  '  flowchart LR\n    A[Application flow] --> E[Native proxy]\n    E --> I{Verified}\n', // leading blanks, trailing newline
]
const no = [
  'pie\nis tasty',
  'timeline\nnotes for tomorrow',
  'journey\nwas long',
  'graph is a nice word\nsecond line',
  'flowchart', // a single word
  'graph TD', // one line only
  'hello world\nflowchart LR\n  A --> B', // keyword not on the first line
  'def f():\n  return 1',
  'gantt\njust text',
  '',
]
for (const s of yes) assert.ok(looksLikeMermaid(s), `should be a diagram: ${JSON.stringify(s.slice(0, 40))}`)
for (const s of no) assert.ok(!looksLikeMermaid(s), `should stay text: ${JSON.stringify(s.slice(0, 40))}`)

// typographic characters from chat UIs / word processors are repaired before rendering
assert.equal(cleanMermaid('A –> B'), 'A --> B', 'en dash')
assert.equal(cleanMermaid('A —> B'), 'A --> B', 'em dash')
assert.equal(cleanMermaid('A −> B'), 'A --> B', 'minus sign')
assert.equal(cleanMermaid('A –>> B'), 'A -->> B', 'sequence-diagram arrow')
assert.equal(cleanMermaid('A[“quoted”] --> B[it’s]'), 'A["quoted"] --> B[it\'s]', 'curly quotes')
assert.equal(cleanMermaid('A[x y] --> B'), 'A[x y] --> B', 'non-breaking space')
assert.equal(cleanMermaid('A --> B'), 'A --> B', 'plain ASCII is left alone')
assert.equal(cleanMermaid('A[Jan – Feb] --> B'), 'A[Jan – Feb] --> B', 'a dash inside a label (not before ">") is kept')
console.log(`mermaid-detect OK — ${yes.length} diagrams recognised, ${no.length} texts left alone, typographic arrows repaired`)
