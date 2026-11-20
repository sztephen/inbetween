import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { ToolRegistry } from '../core/tools/registry'

export interface McpServerOptions {
  registry: ToolRegistry
  instructions: string
  version: string
  /** Preferred port; the next free ports are tried if it is taken. */
  port: number
  token: string
  /** Extra localhost routes (Studio plugin). Return true when handled. */
  extra?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => Promise<boolean> | boolean
  onClientsChanged?: (count: number) => void
}

export const newToken = (): string => randomBytes(24).toString('base64url')

const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' })
  res.end(text)
}

/**
 * Local MCP server (Streamable HTTP) exposing the tool registry. Bound to 127.0.0.1 only,
 * requires a bearer token, and rejects browser-originated requests (Origin/Host checks) so a
 * web page cannot drive the app.
 */
export class McpHost {
  private http: HttpServer | null = null
  private sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>()
  port = 0
  error: string | undefined

  constructor(private opts: McpServerOptions) {}

  get running(): boolean {
    return !!this.http?.listening
  }
  get clients(): number {
    return this.sessions.size
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? ''
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '')
    const want = Buffer.from(this.opts.token)
    return given.length === want.length && timingSafeEqual(given, want)
  }

  private makeServer(sessionRef: { id: string }): Server {
    const { registry } = this.opts
    const server = new Server(
      { name: 'inbetween', title: 'Inbetween', version: this.opts.version },
      { capabilities: { tools: {} }, instructions: this.opts.instructions }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' } }))
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const res = await registry.call(request.params.name, request.params.arguments ?? {}, 'mcp', `mcp:${sessionRef.id}`)
      return {
        content: [
          { type: 'text' as const, text: res.text },
          ...(res.images ?? []).map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))
        ],
        ...(res.isError ? { isError: true } : {})
      }
    })
    return server
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    if (!this.authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: missing or wrong bearer token. Copy the MCP config again from Inbetween > Settings.' }, id: null })
    }
    const sid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sid) ? sid[0] : sid
    let parsed: unknown
    if (req.method === 'POST') {
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
      }
    }
    let entry = sessionId ? this.sessions.get(sessionId) : undefined
    if (!entry) {
      if (req.method !== 'POST' || !isInitializeRequest(parsed)) {
        return send(res, sessionId ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Unknown session. Re-initialize.' : 'No session. Send an initialize request first.' }, id: null })
      }
      const ref = { id: '' }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          ref.id = id
          this.sessions.set(id, created)
          this.opts.registry.store.touchConsumer(`mcp:${id}`)
          this.opts.onClientsChanged?.(this.sessions.size)
        }
      })
      const server = this.makeServer(ref)
      const created = { transport, server }
      transport.onclose = () => {
        if (ref.id && this.sessions.delete(ref.id)) this.opts.onClientsChanged?.(this.sessions.size)
      }
      await server.connect(transport)
      entry = created
    }
    await entry.transport.handleRequest(req, res, parsed)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding and cross-site protection: local Host only, and no foreign Origin.
    if (!LOCAL_HOSTS.test(req.headers.host ?? '')) return send(res, 403, 'Forbidden host')
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return send(res, 403, 'Forbidden origin')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
    if (url.pathname === '/mcp') return this.handleMcp(req, res, body)
    if (url.pathname === '/health') return send(res, 200, { app: 'inbetween', version: this.opts.version })
    if (this.opts.extra && (await this.opts.extra(req, res, body))) return
    send(res, 404, 'Not found')
  }

  async start(): Promise<void> {
    await this.stop()
    this.error = undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = this.opts.port + attempt
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' }, id: null })
          else res.end()
        })
      })
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false))
        server.listen(port, '127.0.0.1', () => resolve(true))
      })
      if (ok) {
        this.http = server
        this.port = port
        return
      }
    }
    this.error = `Could not bind a port in ${this.opts.port}-${this.opts.port + 19}.`
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) await s.transport.close().catch(() => undefined)
    this.sessions.clear()
    const h = this.http
    this.http = null
    if (h) {
      h.closeAllConnections?.()
      await new Promise<void>((r) => h.close(() => r()))
    }
  }
}
