// stdio MCP launcher for clients that only speak stdio (e.g. Claude Desktop).
// It is a thin proxy: tools/list and tools/call are forwarded to the running Inbetween app's
// local HTTP MCP server. Run with Node 18+, or with the packaged app binary and
// ELECTRON_RUN_AS_NODE=1. It finds the app's port and token from the runtime file the app
// writes on start (pass its path as the first argument, or set INBETWEEN_MCP_URL / INBETWEEN_MCP_TOKEN).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

function defaultRuntimeFile(): string {
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Inbetween', 'mcp-runtime.json')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Inbetween', 'mcp-runtime.json')
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Inbetween', 'mcp-runtime.json')
}

function endpoint(): { url: string; token: string } {
  if (process.env.INBETWEEN_MCP_URL) return { url: process.env.INBETWEEN_MCP_URL, token: process.env.INBETWEEN_MCP_TOKEN ?? '' }
  const file = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? defaultRuntimeFile()
  if (!existsSync(file)) throw new Error(`Inbetween does not appear to be running (no ${file}). Open the Inbetween app, then try again.`)
  const rt = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string }
  return { url: rt.url, token: rt.token }
}

let client: Client | null = null
let instructions: string | undefined

async function connect(): Promise<Client> {
  if (client) return client
  const { url, token } = endpoint()
  const c = new Client({ name: 'inbetween-stdio-launcher', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  transport.onclose = () => {
    client = null
  }
  try {
    await c.connect(transport)
  } catch (err) {
    throw new Error(`Could not reach the Inbetween app at ${url}. Make sure it is open. (${err instanceof Error ? err.message : String(err)})`)
  }
  instructions = c.getInstructions()
  client = c
  return c
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  try {
    return await fn(await connect())
  } catch (err) {
    // The app may have restarted (new port/token): drop the connection and try once more.
    client = null
    return fn(await connect())
  }
}

async function main(): Promise<void> {
  // Try to connect up front so the app's instructions can be passed on; fall back gracefully if it is closed.
  await connect().catch(() => undefined)
  const server = new Server(
    { name: 'inbetween', title: 'Inbetween', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: instructions ?? 'Inbetween animation tools. The Inbetween desktop app must be open.' }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => withClient((c) => c.listTools()))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await withClient((c) => c.callTool({ name: req.params.name, arguments: req.params.arguments }, undefined, { timeout: 10 * 60 * 1000 }))
    } catch (err) {
      return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  process.stderr.write(`inbetween-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
