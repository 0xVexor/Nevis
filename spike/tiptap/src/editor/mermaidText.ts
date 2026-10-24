// Text-level helpers for Mermaid source. Pure (no DOM, no imports): tested directly by Node in db/test-mermaid-detect.mjs.

const FIRST_LINE =
  /^(?:(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|sankey-beta|xychart-beta|block-beta|pie(?:\s+showData)?(?:\s+title\s.*)?)\s*;?$/

// Short common words (pie, timeline, journey, graph…) also start ordinary prose, so those types additionally need
// a construct only that diagram has somewhere in the following lines.
const CUE: Record<string, RegExp> = {
  graph: /-->|---|==>|-\.->|\w\s*[[({]/,
  flowchart: /-->|---|==>|-\.->|\w\s*[[({]/,
  pie: /^\s*(title\b|"[^"]+"\s*:\s*[\d.]+)/m,
  gantt: /^\s*(dateFormat|title|section|axisFormat)\b/m,
  journey: /^\s*(title|section)\b/m,
  timeline: /^\s*(title|section)\b|^\s*\S.*\s:\s\S/m,
  mindmap: /^\s{2,}\S/m,
  gitGraph: /^\s*(commit|branch|checkout|merge)\b/m,
}

/** Plain text that is clearly Mermaid source: first line is a diagram keyword and the body looks like that diagram. */
export function looksLikeMermaid(text: string): boolean {
  const [first, ...rest] = text.trim().split(/\r?\n/)
  if (!rest.length || !FIRST_LINE.test(first.trim())) return false
  const cue = CUE[first.trim().split(/[\s;]/)[0]]
  return !cue || cue.test(rest.join('\n'))
}

/**
 * Text that went through a word processor or a chat UI often has typographic characters Mermaid cannot read:
 * "-->" became "–>" (en dash) or "—>", quotes became curly, spaces became non-breaking.
 */
export function cleanMermaid(code: string): string {
  return code
    .replace(/[\u2013\u2014\u2212]+(?=>)/g, '--') // en dash / em dash / minus sign before ">"  ->  "-->"
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00a0/g, ' ')
}
