import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { documentText, projectSearchDocument, searchWords } from '../../spike/tiptap/src/documents/searchProjection.ts'

function createServer() {
  const server = new McpServer({ name: 'nevis-document-spike', version: '0.1.0' })
  server.registerTool('project_sample', {
    description: 'Project caller-supplied sample text through the shared Nevis TypeScript core. No vault or desktop access.',
    inputSchema: z.object({ text: z.string().max(2048) }),
    outputSchema: z.object({ original: z.string(), normalized: z.string(), words: z.array(z.string()), scope: z.literal('sample-only') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ text }) => {
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    const projection = projectSearchDocument({ id: 'sample', title: '', content, updatedAt: 0 })
    const output = { original: documentText(content), normalized: projection.body, words: searchWords(text), scope: 'sample-only' as const }
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }
  })
  return server
}

// Stdout belongs exclusively to MCP. There is intentionally no vault discovery,
// storage import, listener socket, or live-editor fallback in this hosting spike.
void serveStdio(createServer)
