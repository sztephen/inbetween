import Anthropic from '@anthropic-ai/sdk'
import type { ToolRegistry } from '../core/tools/registry'
import type { AgentErrorKind, AgentEvent, ModelOption, Usage, ViewContext } from '../shared/api'

type Msg = Anthropic.Beta.BetaMessageParam
type ContentParam = Anthropic.Beta.BetaContentBlockParam

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const MAX_TOKENS = 32000
const MAX_ITERATIONS = 80

export interface AgentDeps {
  registry: ToolRegistry
  /** Returns a client, or null when no API key is stored. */
  getClient(): Anthropic | null
  getModel(): ModelOption
  system: string
  emit(e: AgentEvent): void
}

/** Turn an SDK/API failure into something the chat panel can show plainly. */
export function describeError(err: unknown): { kind: AgentErrorKind; message: string; retryable: boolean } {
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: 'auth', message: 'Anthropic rejected the API key. Check it in Settings (it should start with "sk-ant-").', retryable: false }
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'auth', message: 'This API key does not have access to the selected model. Pick another model or check the key\'s workspace.', retryable: false }
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { kind: 'model', message: 'The selected model was not found. Choose another model in the picker, or fix its id in the models file (Settings).', retryable: false }
  }
  if (err instanceof Anthropic.RateLimitError) {
    const after = err.headers?.get?.('retry-after')
    return { kind: 'rate_limit', message: `Rate limited by the Claude API.${after ? ` Try again in about ${after}s.` : ' Wait a moment and retry.'}`, retryable: true }
  }
  if (err instanceof Anthropic.APIUserAbortError) return { kind: 'unknown', message: 'Stopped.', retryable: true }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', message: 'Could not reach the Claude API. Check your internet connection and retry.', retryable: true }
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { kind: 'bad_request', message: `The Claude API rejected the request: ${cleanMessage(err)}`, retryable: false }
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || err.status === 503) return { kind: 'overloaded', message: 'The Claude API is overloaded right now. Retry in a moment.', retryable: true }
    if (typeof err.status === 'number' && err.status >= 500) return { kind: 'overloaded', message: `The Claude API had a server error (${err.status}). Retry in a moment.`, retryable: true }
    return { kind: 'unknown', message: `Claude API error${err.status ? ` ${err.status}` : ''}: ${cleanMessage(err)}`, retryable: true }
  }
  return { kind: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: true }
}

function cleanMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: string } } | undefined
  return body?.error?.message ?? err.message.replace(/^\d+\s*/, '')
}

/**
 * The built-in agent: a streaming tool-use loop over the same registry the MCP server exposes.
 * History is append-only (thinking blocks are replayed exactly as received).
 */
export class AgentSession {
  private messages: Msg[] = []
  private abort: AbortController | null = null
  private turn = 0
  running = false
  /** Total usage across the conversation. */
  totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  constructor(private deps: AgentDeps) {
    deps.registry.store.touchConsumer('agent')
  }

  reset(): void {
    this.stop()
    this.messages = []
    this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    this.deps.registry.store.takeUserEdits('agent')
    this.deps.emit({ type: 'reset' })
  }

  stop(): void {
    this.abort?.abort()
  }

  get history(): readonly Msg[] {
    return this.messages
  }

  async send(text: string, view?: ViewContext): Promise<void> {
    if (this.running) return
    const content: ContentParam[] = [{ type: 'text', text }]
    const p = this.deps.registry.store.project
    const clip = p.clips.find((c) => c.id === p.activeClipId)
    const rig = p.rigs.find((r) => r.id === p.activeRigId)
    const ctx: string[] = []
    if (clip) ctx.push(`active clip: "${clip.name}" (${clip.length} frames at ${clip.fps} fps${clip.loop ? ', looping' : ''})`)
    if (rig) ctx.push(`active rig: "${rig.name}"`)
    if (view) ctx.push(`the user is looking at frame ${Math.round(view.frame)}${view.selectedBone ? ` with ${view.selectedBone} selected` : ''}`)
    if (ctx.length) content.push({ type: 'text', text: `<viewport>${ctx.join('; ')}</viewport>` })
    const edits = this.deps.registry.store.takeUserEdits('agent')
    if (edits.length) {
      content.push({ type: 'text', text: `<manual_edits>The user edited the animation by hand since your last turn. Keep these changes unless asked otherwise:\n- ${edits.join('\n- ')}\n</manual_edits>` })
    }
    this.messages.push({ role: 'user', content })
    await this.run()
  }

  /** Re-run after an error. The failed request never reached history, so this resends the same conversation. */
  async retry(): Promise<void> {
    if (this.running || !this.messages.length) return
    await this.run()
  }

  private async run(): Promise<void> {
    const { emit, registry } = this.deps
    const turn = ++this.turn
    this.running = true
    this.abort = new AbortController()
    emit({ type: 'turn_start', turn })
    let stopped = false
    try {
      const client = this.deps.getClient()
      if (!client) {
        emit({ type: 'error', kind: 'no_key', message: 'Add your Claude API key in Settings to use the built-in agent. (MCP clients such as Claude Code can drive the app without a key.)', retryable: false })
        return
      }
      const model = this.deps.getModel()
      const tools: Anthropic.Beta.BetaTool[] = registry.list().map((t) => ({
        name: t.name, description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool['input_schema'],
        eager_input_streaming: true
      }))
      let jsonRetries = 0

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const id = `a${turn}_${i}`
        emit({ type: 'assistant_start', id })
        const toolChips = new Map<number, string>()
        let message: Anthropic.Beta.BetaMessage
        try {
          const stream = client.beta.messages.stream({
            model: model.id,
            max_tokens: MAX_TOKENS,
            system: this.deps.system,
            cache_control: { type: 'ephemeral' },
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: model.effort ?? 'medium' },
            tools,
            messages: this.messages,
            ...(model.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {})
          }, { signal: this.abort.signal })
          for await (const ev of stream) {
            if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
              toolChips.set(ev.index, ev.content_block.id)
              emit({ type: 'tool_start', id, toolId: ev.content_block.id, name: ev.content_block.name, chip: registry.chipFor(ev.content_block.name, undefined) })
            } else if (ev.type === 'content_block_delta') {
              if (ev.delta.type === 'text_delta') emit({ type: 'text', id, delta: ev.delta.text })
              else if (ev.delta.type === 'thinking_delta') emit({ type: 'thinking', id, delta: ev.delta.thinking })
            }
          }
          message = await stream.finalMessage()
        } catch (err) {
          // The SDK throws a plain Error when streamed tool JSON cannot be parsed; re-issue that turn a couple of times.
          if (!(err instanceof Anthropic.APIError) && !this.abort.signal.aborted && jsonRetries < 2 && /JSON/i.test(String((err as Error)?.message))) {
            jsonRetries++
            i--
            continue
          }
          throw err
        }
        jsonRetries = 0

        const u = message.usage
        const usage: Usage = {
          input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0
        }
        this.totals.input += usage.input
        this.totals.output += usage.output
        this.totals.cacheRead += usage.cacheRead
        this.totals.cacheWrite += usage.cacheWrite
        emit({ type: 'usage', id, usage, model: message.model })

        const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')

        if (message.stop_reason === 'refusal') {
          for (const t of toolUses) emit({ type: 'tool_end', toolId: t.id, isError: true, summary: 'not run' })
          emit({ type: 'error', kind: 'refusal', message: 'Claude declined to continue with this request. Try rephrasing it, or switch models.', retryable: false })
          // Drop the refused user turn so the conversation can continue cleanly.
          while (this.messages.length && this.messages[this.messages.length - 1].role === 'user') this.messages.pop()
          return
        }
        if (message.stop_reason === 'max_tokens' && toolUses.length) {
          // A tool input cut off by the token limit may parse as valid but incomplete: never run it.
          for (const t of toolUses) emit({ type: 'tool_end', toolId: t.id, isError: true, summary: 'cut off' })
          emit({ type: 'error', kind: 'truncated', message: 'The response hit the output limit in the middle of a tool call, so nothing was run. Retry, or ask for the work in smaller steps.', retryable: true })
          return
        }

        this.messages.push({ role: 'assistant', content: message.content as ContentParam[] })

        if (message.stop_reason === 'pause_turn') continue
        if (message.stop_reason !== 'tool_use' || !toolUses.length) {
          if (message.stop_reason === 'max_tokens') emit({ type: 'error', kind: 'truncated', message: 'The reply was cut off at the output limit. Say "continue" to carry on.', retryable: false })
          return
        }

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        for (const t of toolUses) {
          if (this.abort.signal.aborted) {
            results.push({ type: 'tool_result', tool_use_id: t.id, content: 'Not run: the user stopped the turn.', is_error: true })
            emit({ type: 'tool_end', toolId: t.id, isError: true, summary: 'stopped' })
            continue
          }
          emit({ type: 'tool_label', toolId: t.id, chip: registry.chipFor(t.name, t.input) })
          const res = await registry.call(t.name, t.input, 'agent', 'agent')
          const blocks: Anthropic.Beta.BetaToolResultBlockParam['content'] = [{ type: 'text', text: res.text }]
          for (const img of res.images ?? []) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })
          results.push({ type: 'tool_result', tool_use_id: t.id, content: blocks, ...(res.isError ? { is_error: true } : {}) })
          emit({ type: 'tool_end', toolId: t.id, isError: !!res.isError, summary: res.text.slice(0, 600), image: res.images?.[0]?.data })
        }
        this.messages.push({ role: 'user', content: results })
        if (this.abort.signal.aborted) {
          stopped = true
          return
        }
      }
      emit({ type: 'error', kind: 'unknown', message: `Stopped after ${MAX_ITERATIONS} steps in one turn. Send a message to continue.`, retryable: false })
    } catch (err) {
      if (this.abort?.signal.aborted) {
        stopped = true
        this.repairAfterAbort()
      } else {
        const d = describeError(err)
        emit({ type: 'error', ...d })
      }
    } finally {
      this.running = false
      this.abort = null
      emit({ type: 'turn_end', turn, stopped })
    }
  }

  /** An aborted stream leaves history ending on a user message; that is a valid place to resume from. */
  private repairAfterAbort(): void {
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'assistant') {
      const pending = (last.content as ContentParam[]).filter((b) => b.type === 'tool_use') as Anthropic.Beta.BetaToolUseBlockParam[]
      if (pending.length) {
        this.messages.push({ role: 'user', content: pending.map((t) => ({ type: 'tool_result' as const, tool_use_id: t.id, content: 'Not run: the user stopped the turn.', is_error: true })) })
      }
    }
  }
}

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', effort: 'medium', fallbacks: true },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'medium', fallbacks: true },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', effort: 'medium', fallbacks: true }
]

export function createClient(apiKey: string, baseURL = 'https://api.anthropic.com'): Anthropic {
  // baseURL is passed explicitly so an ANTHROPIC_BASE_URL in the environment cannot redirect the key.
  return new Anthropic({ apiKey, baseURL, maxRetries: 2, authToken: null })
}
