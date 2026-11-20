import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { getClip } from '@core/clip'
import type { AgentEvent } from '../src/shared/api'
import { AgentSession, createClient, describeError } from '../src/main/agent'
import { makeHarness } from './helpers'

// The built-in agent loop against a mocked Claude API: streaming, tool calls, usage and error states.

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }

function streamBody(blocks: Block[], stop: string, inputTokens = 900, outputTokens = 40): string {
  const ev: Record<string, unknown>[] = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } }]
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
      for (const piece of b.text.match(/.{1,9}/gs) ?? []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } })
    } else {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      for (const piece of JSON.stringify(b.input).match(/.{1,11}/gs) ?? []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: piece } })
    }
    ev.push({ type: 'content_block_stop', index: i })
  })
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } })
  ev.push({ type: 'message_stop' })
  return ev.map((e) => `event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

interface Mock {
  url: string
  requests: { body: any; headers: Record<string, unknown> }[]
}
function mock(handler: (n: number, body: any) => { status?: number; headers?: Record<string, string>; body: string }): Promise<Mock> {
  const requests: Mock['requests'] = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push({ body, headers: req.headers })
      const r = handler(requests.length, body)
      res.writeHead(r.status ?? 200, { 'content-type': (r.status ?? 200) === 200 ? 'text/event-stream' : 'application/json', ...r.headers })
      res.end(r.body)
    })
  })
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, requests })))
}

function session(url: string | null, opts: { key?: string | null } = {}) {
  const h = makeHarness()
  const events: AgentEvent[] = []
  const agent = new AgentSession({
    registry: h.registry, system: 'test system prompt',
    getClient: () => (opts.key === null || url === null ? null : createClient(opts.key ?? 'sk-ant-test', url)),
    getModel: () => ({ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', effort: 'medium', fallbacks: true }),
    emit: (e) => events.push(e)
  })
  return { h, agent, events }
}
const errorJson = (type: string, message: string): string => JSON.stringify({ type: 'error', error: { type, message } })

describe('built-in agent loop (mocked Claude API)', () => {
  it('streams text, runs tool calls against the registry, returns results and images, and tracks usage', async () => {
    const m = await mock((n) => {
      if (n === 1) return { body: streamBody([
        { type: 'text', text: 'Blocking the nod.' },
        { type: 'tool_use', id: 'toolu_a', name: 'set_pose', input: { frame: 0 } },
        { type: 'tool_use', id: 'toolu_b', name: 'set_pose', input: { frame: 10, bones: { Head: { rotation: [-25, 0, 0] } } } },
        { type: 'tool_use', id: 'toolu_c', name: 'set_pose', input: { frame: -4 } }
      ], 'tool_use') }
      if (n === 2) return { body: streamBody([{ type: 'tool_use', id: 'toolu_d', name: 'preview', input: { frames: 'keys' } }], 'tool_use') }
      return { body: streamBody([{ type: 'text', text: 'Done, reviewed the preview.' }], 'end_turn', 1500, 20) }
    })
    const { h, agent, events } = session(m.url)
    await agent.send('make it nod', { frame: 7, selectedBone: 'Head' })

    // Document was edited by the tool calls.
    expect(getClip(h.store.project).tracks.r15.Head.map((k) => k.frame)).toEqual([0, 10])
    // Streaming: text arrived in several deltas, in order.
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)
    expect(text.length).toBeGreaterThan(3)
    expect(text.join('')).toBe('Blocking the nod.Done, reviewed the preview.')
    // Tool chips: start, label refined once the input is complete, end with status.
    const starts = events.filter((e) => e.type === 'tool_start') as Extract<AgentEvent, { type: 'tool_start' }>[]
    expect(starts.map((s) => s.name)).toEqual(['set_pose', 'set_pose', 'set_pose', 'preview'])
    const labels = events.filter((e) => e.type === 'tool_label').map((e) => (e as { chip: string }).chip)
    expect(labels).toEqual(['posing frame 0', 'posing frame 10', 'set pose', 'previewing'])
    const ends = events.filter((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>[]
    expect(ends.map((e) => e.isError)).toEqual([false, false, true, false])
    expect(ends[3].image).toBeTruthy()
    // Usage per message and running totals.
    const usage = events.filter((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>[]
    expect(usage).toHaveLength(3)
    expect(usage[0].usage).toEqual({ input: 900, output: 40, cacheRead: 100, cacheWrite: 0 })
    expect(agent.totals).toEqual({ input: 3300, output: 100, cacheRead: 300, cacheWrite: 0 })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn_end' })

    // Request shape.
    const [r1, r2, r3] = m.requests.map((r) => r.body)
    expect(r1.model).toBe('claude-sonnet-5-5')
    expect(r1.stream).toBe(true)
    expect(r1.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(r1.output_config).toEqual({ effort: 'medium' })
    expect(r1.fallbacks).toBe('default')
    expect(String(m.requests[0].headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
    expect(r1.tools.find((t: any) => t.name === 'set_pose').eager_input_streaming).toBe(true)
    expect(r1.tool_choice).toBeUndefined()
    expect(JSON.stringify(r1.messages[0].content)).toContain('the user is looking at frame 7 with Head selected')
    // All tool results for one assistant turn go back in a single user message; failures are flagged.
    const results = r2.messages[2].content
    expect(results.map((c: any) => c.type)).toEqual(['tool_result', 'tool_result', 'tool_result'])
    expect(results[2].is_error).toBe(true)
    expect(results[2].content[0].text).toMatch(/Invalid arguments for set_pose/)
    // The preview image is returned to the model as an image block.
    const previewResult = r3.messages[4].content[0]
    expect(previewResult.content.some((b: any) => b.type === 'image' && b.source.media_type === 'image/png')).toBe(true)
    // History is append-only: later requests extend earlier ones unchanged.
    expect(JSON.stringify(r3.messages.slice(0, r2.messages.length))).toBe(JSON.stringify(r2.messages))
  })

  it('tells the model about manual edits on the next turn', async () => {
    const m = await mock(() => ({ body: streamBody([{ type: 'text', text: 'ok' }], 'end_turn') }))
    const { h, agent } = session(m.url)
    await agent.send('hi')
    h.store.mutate('user', 'moved keys on R15: frame 10 -> 14', () => undefined)
    await agent.send('continue')
    const last = m.requests[1].body.messages.at(-1)
    expect(JSON.stringify(last.content)).toContain('<manual_edits>')
    expect(JSON.stringify(last.content)).toContain('moved keys on R15: frame 10 -> 14')
  })

  it('reports a missing key without calling the API', async () => {
    const { agent, events } = session(null)
    await agent.send('hello')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ kind: 'no_key', retryable: false })
  })

  it('bad key, rate limit and server errors become clear messages; retry resends the same turn', async () => {
    let mode = 'auth'
    const m = await mock((): { status?: number; headers?: Record<string, string>; body: string } => {
      if (mode === 'auth') return { status: 401, body: errorJson('authentication_error', 'invalid x-api-key') }
      if (mode === 'rate') return { status: 429, headers: { 'retry-after': '12', 'x-should-retry': 'false' }, body: errorJson('rate_limit_error', 'slow down') }
      if (mode === 'overloaded') return { status: 529, headers: { 'x-should-retry': 'false' }, body: errorJson('overloaded_error', 'Overloaded') }
      if (mode === 'bad') return { status: 400, body: errorJson('invalid_request_error', 'max_tokens too large') }
      return { body: streamBody([{ type: 'text', text: 'recovered' }], 'end_turn') }
    })
    const { agent, events } = session(m.url)
    const lastError = (): Extract<AgentEvent, { type: 'error' }> => [...events].reverse().find((e) => e.type === 'error') as never
    await agent.send('go')
    expect(lastError()).toMatchObject({ kind: 'auth', retryable: false })
    expect(lastError().message).toMatch(/rejected the API key/)
    mode = 'rate'
    await agent.retry()
    expect(lastError()).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(lastError().message).toMatch(/about 12s/)
    mode = 'overloaded'
    await agent.retry()
    expect(lastError()).toMatchObject({ kind: 'overloaded', retryable: true })
    mode = 'bad'
    await agent.retry()
    expect(lastError()).toMatchObject({ kind: 'bad_request' })
    expect(lastError().message).toMatch(/max_tokens too large/)
    mode = 'ok'
    await agent.retry()
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('recovered')
    // Failed attempts never polluted history: every request carried exactly the one user message.
    for (const r of m.requests) expect(r.body.messages).toHaveLength(1)
  })

  it('network failures are reported as such', async () => {
    const { agent, events } = session('http://127.0.0.1:9')
    await agent.send('go')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ kind: 'network', retryable: true })
  }, 60000)

  it('never runs tools from a refused or truncated response', async () => {
    let stop = 'refusal'
    const m = await mock(() => ({ body: streamBody([{ type: 'tool_use', id: 'toolu_x', name: 'create_clip', input: { name: 'Nope' } }], stop) }))
    const { h, agent, events } = session(m.url)
    await agent.send('x')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ kind: 'refusal' })
    stop = 'max_tokens'
    await agent.send('y')
    expect([...events].reverse().find((e) => e.type === 'error')).toMatchObject({ kind: 'truncated' })
    expect(h.store.project.clips.some((c) => c.name === 'Nope')).toBe(false)
  })

  it('describes unknown errors without leaking internals', () => {
    expect(describeError(new Error('boom'))).toEqual({ kind: 'unknown', message: 'boom', retryable: true })
  })
})
