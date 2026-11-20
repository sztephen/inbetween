import { z } from 'zod'
import type { ProjectStore, Touched } from '../document'
import type { Project } from '../types'

export interface ToolImage {
  mimeType: 'image/png'
  /** base64 */
  data: string
}

export interface ToolResult {
  text: string
  images?: ToolImage[]
  isError?: boolean
}

export interface PreviewRequest {
  project: Project
  clipId: string
  rigIds: string[]
  frames: number[]
  views: string[]
  onionSkin: boolean
  /** Chain or bone names to draw motion trails for. */
  trails: string[]
  cellSize: number
  /** Rig whose eyes first-person views look through. */
  subjectRigId?: string
}

export interface VideoRequest {
  project: Project
  clipId: string
  format: 'mp4' | 'gif' | 'webm'
  path: string
  width: number
  height: number
  fps: number
  /** 'transparent' or a CSS hex colour. */
  background: string
  /** 'track' uses the clip's camera track; otherwise a named view. */
  camera: string
  /** Rig for first-person cameras. */
  rigId?: string
  /** Who asked for the render, so stopping that AI can stop its render too. */
  source?: 'agent' | 'mcp'
}

/** Services the surrounding app provides to tools (rendering, files). Tests supply fakes. */
export interface ToolHost {
  renderPreview(req: PreviewRequest): Promise<ToolImage>
  renderVideo(req: VideoRequest, onProgress?: (p: number) => void): Promise<{ path: string; frames: number }>
  /** Stop the video render in progress, if any. Returns what was stopped, or null when nothing was rendering. */
  cancelRender?(): { label: string; progress: number } | null
  /** The video render in progress, if any. */
  renderStatus?(): { label: string; progress: number; path: string } | null
  writeFile(path: string, data: Uint8Array | string): Promise<string>
  readFile(path: string): Promise<Uint8Array>
  /** Resolve a file name (or absolute path) to where exports are written. */
  resolveExportPath(name: string): string
}

export interface CallContext {
  store: ProjectStore
  host: ToolHost
  /** 'agent' for the built-in chat, 'mcp' for external clients. */
  source: 'agent' | 'mcp'
  /** Identity of the calling AI client, e.g. "agent" or "mcp:<session id>". */
  consumer?: string
  /** Report which frames/bones changed so the UI can animate them. */
  touch(t: Touched): void
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  /** Short present-tense label for the UI chip, e.g. "posing frame 12". */
  chip(args: z.infer<S>): string
  handler(args: z.infer<S>, ctx: CallContext): Promise<ToolResult | string | object> | ToolResult | string | object
  /** Runs immediately instead of waiting behind other calls (control tools such as cancelling a render). */
  concurrent?: boolean
  /** Offered to MCP clients only, never to the built-in agent. */
  mcpOnly?: boolean
}

export const defineTool = <S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> => t

export interface ToolListing {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mcpOnly?: boolean
}

export type ToolListener = (e: { phase: 'start' | 'end'; id: string; name: string; chip: string; source: 'agent' | 'mcp'; isError?: boolean }) => void

let callSeq = 0

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private listeners = new Set<ToolListener>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(public store: ProjectStore, public host: ToolHost, defs: ToolDef[]) {
    for (const d of defs) this.tools.set(d.name, d as ToolDef)
  }

  /** Add a tool after construction (tools that need the app, such as handing work to the built-in AI). */
  register(def: ToolDef): void {
    this.tools.set(def.name, def as ToolDef)
  }

  onCall(fn: ToolListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  list(): ToolListing[] {
    return [...this.tools.values()].map((t) => {
      const schema = z.toJSONSchema(t.schema, { target: 'draft-7' }) as Record<string, unknown>
      delete schema.$schema
      return { name: t.name, description: t.description, inputSchema: schema, ...(t.mcpOnly ? { mcpOnly: true } : {}) }
    })
  }

  chipFor(name: string, args: unknown): string {
    const t = this.tools.get(name)
    if (!t) return name
    const parsed = t.schema.safeParse(args ?? {})
    try {
      return parsed.success ? t.chip(parsed.data) : name.replace(/_/g, ' ')
    } catch {
      return name.replace(/_/g, ' ')
    }
  }

  /**
   * Run a tool. Never throws: failures come back as isError results with a message the model
   * can act on. Calls are serialised so concurrent clients cannot interleave edits.
   * `consumer` identifies the AI client so it is told once about manual edits made since its last call.
   */
  call(name: string, args: unknown, source: 'agent' | 'mcp', consumer: string): Promise<ToolResult> {
    const run = async (): Promise<ToolResult> => {
      const id = `call_${++callSeq}`
      const tool = this.tools.get(name)
      if (!tool) return { text: `Unknown tool "${name}". Available: ${[...this.tools.keys()].join(', ')}`, isError: true }
      const parsed = tool.schema.safeParse(args ?? {})
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')
        return { text: `Invalid arguments for ${name}: ${issues}`, isError: true }
      }
      let chip = name
      try {
        chip = tool.chip(parsed.data)
      } catch { /* label only */ }
      for (const l of this.listeners) l({ phase: 'start', id, name, chip, source })
      let result: ToolResult
      const touched: Touched = {}
      try {
        const ctx: CallContext = { store: this.store, host: this.host, source, consumer, touch: (t) => Object.assign(touched, t) }
        const out = await tool.handler(parsed.data, ctx)
        if (typeof out === 'string') result = { text: out }
        else if (out && typeof out === 'object' && 'text' in out && typeof (out as ToolResult).text === 'string') result = out as ToolResult
        else result = { text: JSON.stringify(out) }
      } catch (err) {
        result = { text: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
      const edits = this.store.takeUserEdits(consumer)
      if (edits.length) {
        result.text += `\n\nNOTE: the user made manual edits since your last call. Keep them unless asked otherwise:\n- ${edits.join('\n- ')}`
      }
      for (const l of this.listeners) l({ phase: 'end', id, name, chip, source, isError: result.isError })
      return result
    }
    if (this.tools.get(name)?.concurrent) return run()
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }
}
