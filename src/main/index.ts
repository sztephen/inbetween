import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { createClip, getClip, getRig, newId, settleNewRig } from '../core/clip'
import { defaultProject, parseProject, ProjectStore, serializeProject } from '../core/document'
import { clipToSequence, parseRbxmx, sequenceToClip } from '../core/export/rbxmx'
import { importGlbRig } from '../core/import/gltf'
import { importRobloxRig } from '../core/import/robloxRig'
import { buildTools } from '../core/tools'
import { defineTool, ToolRegistry, type ToolHost, type ToolImage } from '../core/tools/registry'
import type { Rig } from '../core/types'
import workflow from '../core/workflow.md?raw'
import type { DocState, ExportProgress, McpInfo, RenderRequest, Settings, SettingsState, UserCommand, ViewContext } from '../shared/api'
import { AgentSession, createClient, type AgentTool } from './agent'
import { McpHost, newToken } from './mcp'
import { SettingsStore } from './settings'
import { runUserCommand } from './userCommands'
import { encodeVideo, RenderCancelled } from './video'
import { z } from 'zod'

app.setName('Inbetween')
// Development/test conveniences. Ignored in packaged builds so a shipped app always uses the
// real user-data folder and only ever talks to api.anthropic.com.
const devArg = (name: string): string | undefined =>
  app.isPackaged ? undefined : process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? process.env[`INBETWEEN_${name.toUpperCase().replace(/-/g, '_')}`]
const userDataOverride = devArg('user-data')
if (userDataOverride) app.setPath('userData', userDataOverride)
const mockApi = devArg('mock-api')
// Automated runs must never block on a save prompt.
const unattended = !app.isPackaged && process.argv.includes('--e2e')

const SYSTEM_PROMPT =
  'You are the animator built into Inbetween, a desktop app for animating 3D rigs. You work in a chat panel beside a live 3D viewport; ' +
  'every tool call you make updates the viewport immediately, and the person can see small chips for each call, so you do not need to narrate each step. ' +
  'Keep chat replies short and plain: say what you are about to do when it helps, and finish with a brief summary of what you made and anything worth their attention. ' +
  'When a request is ambiguous in a way that changes the animation substantially, make a reasonable choice, say what you chose, and carry on.\n\n' + workflow

const LEAD_PROMPT = SYSTEM_PROMPT +
  '\n\n## Several animations in one request\n\n' +
  'When the person asks for two or more separate animations in one message ("a punch, a walk cycle and a wave"), do not animate them one after another yourself. ' +
  'Call `animate_in_parallel` once with one task per animation: each gets its own clip and its own animator, they all work at the same time, and the person can follow each in its own tab. ' +
  'Afterwards, reply with one short line per clip. A single animation, or several steps of one animation, you do yourself.'

const workerPrompt = (clip: string, rig: string): string => SYSTEM_PROMPT +
  '\n\n## You are one of several animators working at the same time\n\n' +
  `Each animator has their own clip. Yours is "${clip}", already created and empty, on the rig "${rig}". Tool calls that leave out \`clip\` and \`rig\` use yours, so you can leave them out. ` +
  'Work only in your clip: do not activate, rename or delete clips, and change your own clip\'s length, fps or loop flag with `update_clip` if the brief needs it. ' +
  'The undo history is shared with the other animators, so do not call `undo`; fix a pose by posing it again or deleting its keys. ' +
  'Nobody can answer questions while you work, so make reasonable choices and finish the animation, then give a two or three sentence summary.'

let win: BrowserWindow | null = null
let rendererReady: Promise<void> = Promise.resolve()
let resolveReady: (() => void) | null = null
let quitting = false
let viewContext: ViewContext = { frame: 0, selectedBone: null }

const settings = new SettingsStore()
const store = new ProjectStore(defaultProject())

// ---------------------------------------------------------------- renderer bridge

const pendingRenders = new Map<number, { resolve: (v: Uint8Array | string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
let renderSeq = 0

async function ensureWindow(): Promise<BrowserWindow> {
  if (!win || win.isDestroyed()) createWindow()
  await rendererReady
  return win!
}

async function renderInWindow(request: RenderRequest, timeoutMs = 60000): Promise<Uint8Array | string> {
  const w = await ensureWindow()
  const id = ++renderSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRenders.delete(id)
      reject(new Error('The viewport did not answer in time. Is the Inbetween window responding?'))
    }, timeoutMs)
    pendingRenders.set(id, { resolve, reject, timer })
    w.webContents.send('render:request', id, request)
  })
}

function sendExportProgress(p: ExportProgress): void {
  win?.webContents.send('export:progress', p)
}

/** The video render in progress. Only one runs at a time (tool calls are serialised). */
let currentRender: { abort: AbortController; label: string; progress: number; path: string; source?: 'agent' | 'mcp' } | null = null

function cancelRender(onlySource?: 'agent' | 'mcp'): { label: string; progress: number } | null {
  const r = currentRender
  if (!r || (onlySource && r.source !== onlySource)) return null
  r.abort.abort()
  return { label: r.label, progress: r.progress }
}

const host: ToolHost = {
  async renderPreview(req): Promise<ToolImage> {
    const data = await renderInWindow({ kind: 'preview', req })
    const b64 = typeof data === 'string' ? data.replace(/^data:image\/png;base64,/, '') : Buffer.from(data).toString('base64')
    return { mimeType: 'image/png', data: b64 }
  },
  async renderVideo(req) {
    const clip = getClip(req.project, req.clipId)
    const seconds = clip.length / clip.fps
    // Looping clips skip the duplicated last frame so the video loops cleanly.
    const total = Math.max(1, Math.round(seconds * req.fps) + (clip.loop ? 0 : 1))
    const width = req.width - (req.width % 2), height = req.height - (req.height % 2)
    const label = `Rendering ${req.format.toUpperCase()}`
    const job = { abort: new AbortController(), label, progress: 0, path: req.path, source: req.source }
    currentRender = job
    sendExportProgress({ active: true, label, progress: 0 })
    try {
      await renderInWindow({ kind: 'videoBegin', req: { ...req, width, height }, frames: total })
      const frames = await encodeVideo(
        { format: req.format, path: req.path, width, height, fps: req.fps, transparent: req.background === 'transparent' },
        async (i) => {
          if (i >= total) return null
          const data = await renderInWindow({ kind: 'videoFrame', index: i, time: i / req.fps }, 30000)
          job.progress = (i + 1) / total
          if (!job.abort.signal.aborted) sendExportProgress({ active: true, label, progress: job.progress })
          return data as Uint8Array
        }, job.abort.signal)
      sendExportProgress({ active: false, label: 'Exported', progress: 1, path: req.path })
      return { path: req.path, frames }
    } catch (err) {
      if (err instanceof RenderCancelled) {
        sendExportProgress({ active: false, label: 'Render stopped', progress: 0 })
        throw new Error('Render cancelled. The partial file was deleted.')
      }
      sendExportProgress({ active: false, label: 'Export failed', progress: 0, error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      if (currentRender === job) currentRender = null
      await renderInWindow({ kind: 'videoEnd' }, 10000).catch(() => undefined)
    }
  },
  cancelRender: () => cancelRender(),
  renderStatus() {
    const r = currentRender
    return r && !r.abort.signal.aborted ? { label: r.label, progress: r.progress, path: r.path } : null
  },
  async writeFile(path, data) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    return path
  },
  async readFile(path) {
    return new Uint8Array(readFileSync(path))
  },
  resolveExportPath(name) {
    if (isAbsolute(name)) return name
    mkdirSync(settings.settings.exportDir, { recursive: true })
    return join(settings.settings.exportDir, name)
  }
}

const registry = new ToolRegistry(store, host, buildTools())

// ---------------------------------------------------------------- MCP + Studio endpoints

const tokenFile = join(app.getPath('userData'), 'mcp-token')
const runtimeFile = join(app.getPath('userData'), 'mcp-runtime.json')
function loadToken(): string {
  try {
    const t = readFileSync(tokenFile, 'utf8').trim()
    if (t.length >= 16) return t
  } catch { /* first run */ }
  const t = newToken()
  mkdirSync(dirname(tokenFile), { recursive: true })
  writeFileSync(tokenFile, t, { mode: 0o600 })
  return t
}
const mcpToken = loadToken()

async function studioRoutes(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith('/studio/')) return false
  const json = (status: number, data: unknown): true => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
    return true
  }
  // A custom header cannot be sent cross-site without a CORS preflight, which we never grant.
  if (req.headers['x-inbetween-studio'] !== '1') return json(403, { ok: false, error: 'Missing X-Inbetween-Studio header.' })
  const p = store.project
  try {
    if (url.pathname === '/studio/ping') {
      return json(200, { ok: true, app: 'Inbetween', version: app.getVersion(), project: p.name, clip: p.clips.find((c) => c.id === p.activeClipId)?.name ?? null, rig: p.rigs.find((r) => r.id === p.activeRigId)?.name ?? null })
    }
    if (url.pathname === '/studio/rig' && req.method === 'POST') {
      const rig = importRobloxRig(JSON.parse(body.toString('utf8')), newId('rig'))
      addRig(rig, 'Roblox Studio')
      return json(200, { ok: true, rig: rig.name, bones: rig.bones.length })
    }
    if (url.pathname === '/studio/animation' && req.method === 'GET') {
      const clip = getClip(p), rig = getRig(p)
      if (rig.source === 'gltf') return json(400, { ok: false, error: `The active rig "${rig.name}" is a glTF rig, not a Roblox rig.` })
      return json(200, { ok: true, rig: rig.name, sequence: clipToSequence(clip, rig) })
    }
  } catch (err) {
    return json(400, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
  return json(404, { ok: false, error: 'Unknown Studio endpoint.' })
}

const mcp = new McpHost({
  registry, instructions: workflow, version: app.getVersion(), port: settings.settings.mcpPort, token: mcpToken,
  extra: studioRoutes, onClientsChanged: () => pushSettings()
})

function launcherPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'launcher', 'inbetween-mcp.cjs') : join(app.getAppPath(), 'out', 'launcher', 'inbetween-mcp.cjs')
}

function mcpInfo(): McpInfo {
  const url = mcp.url
  // Packaged: run the launcher with the app's own binary as Node, so no separate Node install is needed.
  const stdio = app.isPackaged
    ? { command: process.execPath, args: [launcherPath(), runtimeFile], env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: 'node', args: [launcherPath(), runtimeFile] }
  const quote = (s: string): string => (process.platform === 'win32' ? `"${s}"` : `'${s}'`)
  return {
    running: mcp.running, port: mcp.port, url, clients: mcp.clients, error: mcp.error,
    claudeCodeCommand: `claude mcp add --transport http inbetween ${url} --header ${quote(`Authorization: Bearer ${mcpToken}`)}`,
    httpConfig: JSON.stringify({ mcpServers: { inbetween: { type: 'http', url, headers: { Authorization: `Bearer ${mcpToken}` } } } }, null, 2),
    stdioConfig: JSON.stringify({ mcpServers: { inbetween: stdio } }, null, 2)
  }
}

async function startMcp(): Promise<void> {
  await mcp.start()
  if (mcp.running) writeFileSync(runtimeFile, JSON.stringify({ url: mcp.url, port: mcp.port, token: mcpToken, pid: process.pid }, null, 2), { mode: 0o600 })
  pushSettings()
}

// ---------------------------------------------------------------- agent

const getClient = (): ReturnType<typeof createClient> | null => {
  if (mockApi) return createClient(settings.getKey() ?? 'mock-key', mockApi)
  const key = settings.getKey()
  return key ? createClient(key) : null
}

/** Parallel animators started by the lead agent, one per clip, each with its own chat tab. */
const workers = new Map<string, AgentSession>()
let workerSeq = 0

function clearWorkers(): void {
  for (const w of workers.values()) w.stop()
  workers.clear()
}

const parallelTool: AgentTool = {
  name: 'animate_in_parallel',
  description:
    'Hand two or more separate animations to parallel animators, one new clip each, all working at the same time. Use this whenever the person asks for several separate animations in one message. ' +
    'Each task gets its own clip and its own tab in the chat, where the person can watch it and give notes. ' +
    'Each animator sees only its own `brief`, so write every brief as a complete description: the action, the feel, roughly how long, whether it loops, and every relevant detail the person gave. ' +
    'Returns when all the animators have finished, with each one\'s summary. Not for a single animation, and not for steps of the same animation.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array', minItems: 2, maxItems: 6,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Clip name, short, e.g. "Heavy punch".' },
            brief: { type: 'string', description: 'Everything the animator needs to know to make this animation.' },
            length: { type: 'integer', minimum: 1, description: 'Last frame index. Default 30 (one second at 30 fps). The animator may change it.' },
            fps: { type: 'integer', minimum: 1, maximum: 120, description: 'Default 30.' },
            loop: { type: 'boolean', description: 'True for cycles (walk, run, idle).' }
          },
          required: ['name', 'brief']
        }
      },
      rig: { type: 'string', description: 'Rig id or name every task animates. Defaults to the active rig.' }
    },
    required: ['tasks']
  },
  chip: (input) => {
    const n = (input as { tasks?: unknown[] } | undefined)?.tasks?.length
    return n ? `animating ${n} clips at once` : 'starting animators'
  },
  run: async (input, signal) => {
    const a = input as { tasks?: { name?: string; brief?: string; length?: number; fps?: number; loop?: boolean }[]; rig?: string }
    const tasks = (a.tasks ?? []).filter((t) => t && typeof t.name === 'string' && typeof t.brief === 'string' && t.name.trim() && t.brief.trim())
    if (tasks.length < 2) return { text: 'animate_in_parallel needs at least two tasks, each with a name and a brief. Animate a single clip yourself.', isError: true }
    if (tasks.length > 6) return { text: 'At most 6 animations at once. Split the request into batches.', isError: true }
    const rig = getRig(store.project, a.rig)
    const clips = store.mutate('agent', `create ${tasks.length} clips`, (p) => {
      const made = tasks.map((t) => {
        let name = t.name!.trim(), i = 2
        while (p.clips.some((c) => c.name === name)) name = `${t.name!.trim()} ${i++}`
        const clip = createClip(name, Math.max(1, Math.round(t.length ?? 30)), Math.min(120, Math.max(1, Math.round(t.fps ?? 30))), !!t.loop)
        if (clip.loop) clip.priority = 'Movement'
        p.clips.push(clip)
        return clip
      })
      p.activeClipId = made[0].id
      return made
    })
    const started = clips.map((clip, i) => {
      const id = `w${++workerSeq}`
      const session = new AgentSession({
        registry, system: workerPrompt(clip.name, rig.name), getClient, getModel: () => settings.currentModel(),
        bind: { clipId: clip.id, rigId: rig.id }, consumer: `agent:${id}`,
        emit: (e) => win?.webContents.send('agent:event', { ...e, agent: id })
      })
      workers.set(id, session)
      win?.webContents.send('agent:event', { type: 'spawn', agent: id, name: clip.name, clipId: clip.id, brief: tasks[i].brief!.trim() })
      return { id, clip, session, brief: tasks[i].brief!.trim() }
    })
    const stopAll = (): void => started.forEach((w) => w.session.stop())
    signal.addEventListener('abort', stopAll)
    try {
      await Promise.all(started.map((w) => w.session.send(w.brief)))
    } finally {
      signal.removeEventListener('abort', stopAll)
    }
    return {
      text: JSON.stringify({
        finished: started.map((w) => ({
          clip: w.clip.name,
          result: w.session.lastError ? `did not finish: ${w.session.lastError}` : w.session.lastReply() || 'ended without a summary',
        })),
        note: 'Each clip has its own tab in the chat where the person can review it and give that animator notes directly.'
      })
    }
  }
}

const agent = new AgentSession({
  registry,
  system: LEAD_PROMPT,
  extraTools: [parallelTool],
  getClient,
  getModel: () => settings.currentModel(),
  emit: (e) => {
    if (e.type === 'reset') clearWorkers()
    win?.webContents.send('agent:event', e)
  }
})

// ---------------------------------------------------------------- MCP clients hand work to the built-in AI

const prettyClient = (name: string | undefined): string => {
  if (!name) return 'an MCP client'
  if (/claude[-_ ]?code/i.test(name)) return 'Claude Code'
  if (/claude/i.test(name)) return 'Claude'
  return name
}

registry.register(defineTool({
  name: 'ask_inbetween_ai',
  description:
    'Hand an animation job to Inbetween\'s built-in AI animator, which runs inside the app on the person\'s own Claude API key and poses, previews and checks the motion by itself. ' +
    'Use this when the person asks for the Inbetween AI (the in-app AI, the built-in AI, "have Inbetween make it") to create or change the motion. The person watches it work in the app\'s chat panel. ' +
    'Write `brief` as a complete description: the action, the feel, timing and length, whether it loops, and any detail the person gave. ' +
    'Returns when the built-in AI has finished, with its summary and the clip it worked in. Afterwards, fine-tune the result yourself: get_clip, preview, check and motion_report, then fix timing, poses and contacts with your own tools. ' +
    'Pass `new_clip` to have it start in a fresh clip, or `clip` to work in an existing one; otherwise it works in the active clip. Use cancel_render or ask the person to press Stop in the chat to interrupt it.',
  schema: z.object({
    brief: z.string().min(1).describe('Everything the built-in AI needs to know to make the animation.'),
    clip: z.string().optional().describe('Existing clip id or name to work in. It becomes the active clip.'),
    new_clip: z.object({
      name: z.string().min(1),
      length: z.number().int().min(1).optional().describe('Last frame index. Default 30.'),
      fps: z.number().int().min(1).max(120).optional().describe('Default 30.'),
      loop: z.boolean().optional()
    }).optional().describe('Create this clip first and have the built-in AI work in it.'),
    rig: z.string().optional().describe('Rig id or name to animate. It becomes the active rig. Default: the active rig.')
  }),
  chip: () => 'handing off to the Inbetween AI',
  concurrent: true,
  mcpOnly: true,
  handler: async (a, ctx) => {
    if (!mockApi && !settings.getKey()) {
      return { text: 'The Inbetween AI has no Claude API key yet. Ask the person to add one in Inbetween > Settings, or animate it yourself with the other tools.', isError: true }
    }
    if (agent.running) return { text: 'The Inbetween AI is busy with another request in the chat panel. Wait for it to finish (or ask the person to stop it), then try again.', isError: true }
    const p = store.project
    const rig = a.rig ? getRig(p, a.rig) : undefined
    if (a.new_clip) {
      const nc = a.new_clip
      store.mutate('mcp', `create clip ${nc.name}`, (proj) => {
        let name = nc.name.trim(), i = 2
        while (proj.clips.some((c) => c.name === name)) name = `${nc.name.trim()} ${i++}`
        const clip = createClip(name, nc.length ?? 30, nc.fps ?? 30, !!nc.loop)
        if (clip.loop) clip.priority = 'Movement'
        proj.clips.push(clip)
        proj.activeClipId = clip.id
        if (rig) proj.activeRigId = rig.id
      })
    } else if (a.clip || rig) {
      const clip = a.clip ? getClip(p, a.clip) : undefined
      store.setActive({ ...(clip ? { activeClipId: clip.id } : {}), ...(rig ? { activeRigId: rig.id } : {}) })
    }
    const from = prettyClient(ctx.consumer?.startsWith('mcp:') ? mcp.clientName(ctx.consumer.slice(4)) : undefined)
    win?.webContents.send('agent:event', { type: 'user_message', text: a.brief.trim(), from })
    await agent.send(
      `${a.brief.trim()}\n\n(This request came from ${from}, which will review and fine-tune your result afterwards. ` +
      'Nobody can answer questions while you work, so make reasonable choices, finish the animation, check and preview it, then end with a short summary: what you made, which clip, and anything you were unsure of.)'
    )
    const clip = store.project.clips.find((c) => c.id === store.project.activeClipId)
    if (agent.lastError) return { text: `The Inbetween AI did not finish: ${agent.lastError}`, isError: true }
    if (agent.lastStopped) return { text: 'The person stopped the Inbetween AI before it finished. Ask them how they want to continue.', isError: true }
    return {
      finished: true,
      clip: clip ? { id: clip.id, name: clip.name, length: clip.length, fps: clip.fps, loop: clip.loop } : null,
      summary: agent.lastReply() || 'It ended without a summary.',
      next: 'Review it now (get_clip, preview, check, motion_report) and fine-tune whatever needs it with your own tools.'
    }
  }
}))

// ---------------------------------------------------------------- state push

function docState(e?: { source: DocState['source']; label: string; touched?: DocState['touched'] }): DocState {
  return {
    project: store.project, version: store.version, source: e?.source ?? 'system', label: e?.label ?? '',
    canUndo: store.canUndo, canRedo: store.canRedo, filePath: store.filePath, dirty: store.dirty, touched: e?.touched
  }
}

function settingsState(): SettingsState {
  return {
    settings: settings.settings, models: settings.models(), modelsFile: settings.modelsFile,
    hasKey: !!settings.getKey(), keyHint: settings.keyHint(), encryptionAvailable: settings.encryptionAvailable, dark: nativeTheme.shouldUseDarkColors,
    platform: process.platform, mcp: mcpInfo(), version: app.getVersion()
  }
}
function pushSettings(): void {
  win?.webContents.send('settings', settingsState())
}

function updateTitle(): void {
  if (!win || win.isDestroyed()) return
  const name = store.filePath ? basename(store.filePath).replace(/\.inbetween$|\.json$/i, '') : store.project.name
  win.setTitle(`${name}${store.dirty ? ' •' : ''} — Inbetween`)
  win.setDocumentEdited(store.dirty)
  if (store.filePath) win.setRepresentedFilename(store.filePath)
}

store.subscribe((e) => {
  win?.webContents.send('doc', docState(e))
  updateTitle()
})
registry.onCall((e) => win?.webContents.send('tool:event', e))

// ---------------------------------------------------------------- files

const projectFilters = [{ name: 'Inbetween Project', extensions: ['inbetween', 'json'] }]

async function confirmDiscard(): Promise<boolean> {
  if (!store.dirty || !win || unattended) return true
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
    message: 'Save changes to this project?', detail: 'Your changes will be lost if you do not save them.'
  })
  if (r.response === 2) return false
  if (r.response === 0) return (await saveProject(false)).ok
  return true
}

async function saveProject(saveAs: boolean): Promise<{ ok: boolean; path?: string; error?: string }> {
  let path = store.filePath
  if (!path || saveAs) {
    const r = await dialog.showSaveDialog(win!, { filters: projectFilters, defaultPath: path ?? join(app.getPath('documents'), `${store.project.name}.inbetween`) })
    if (r.canceled || !r.filePath) return { ok: false }
    path = r.filePath
  }
  try {
    const name = basename(path).replace(/\.inbetween$|\.json$/i, '')
    if (store.project.name !== name) store.project = { ...store.project, name }
    writeFileSync(path, serializeProject(store.project))
    store.markSaved(path)
    app.addRecentDocument(path)
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function openProjectFile(path: string): { ok: boolean; error?: string } {
  try {
    store.load(parseProject(readFileSync(path, 'utf8')), path)
    agent.reset()
    app.addRecentDocument(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function addRig(rig: Rig, from: string): void {
  // Convert a metre-sized model to the scene's studs and stand it beside what is already there.
  const notes = settleNewRig(store.project, rig)
  if (notes.length) win?.webContents.send('toast', { message: `Imported ${rig.name}. ${notes.join(' ')} Ask the AI to move or resize it if needed.`, kind: 'info' })
  store.mutate('user', `imported rig "${rig.name}" from ${from}`, (p) => {
    let n = rig.name, i = 2
    while (p.rigs.some((x) => x.name === n)) n = `${rig.name} ${i++}`
    rig.name = n
    p.rigs.push(rig)
    p.activeRigId = rig.id
  }, { rigId: rig.id })
}

async function fileAction(action: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    if (action === 'new') {
      if (!(await confirmDiscard())) return { ok: false }
      store.load(defaultProject(), null)
      agent.reset()
      return { ok: true }
    }
    if (action === 'open') {
      if (!(await confirmDiscard())) return { ok: false }
      const r = await dialog.showOpenDialog(win!, { filters: projectFilters, properties: ['openFile'] })
      if (r.canceled || !r.filePaths[0]) return { ok: false }
      return { ...openProjectFile(r.filePaths[0]), path: r.filePaths[0] }
    }
    if (action === 'save') return saveProject(false)
    if (action === 'saveAs') return saveProject(true)
    if (action === 'importRig') {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Import a model or rig', properties: ['openFile'],
        filters: [{ name: 'Models and rigs (glTF, GLB, Roblox rig JSON)', extensions: ['glb', 'gltf', 'json'] }]
      })
      if (r.canceled || !r.filePaths[0]) return { ok: false }
      const path = r.filePaths[0]
      const bytes = new Uint8Array(readFileSync(path))
      const id = newId('rig')
      const rig = /\.(glb|gltf)$/i.test(path) ? importGlbRig(bytes, id, undefined, path) : importRobloxRig(JSON.parse(Buffer.from(bytes).toString('utf8')), id)
      addRig(rig, basename(path))
      return { ok: true, path }
    }
    if (action === 'importAnimation') {
      const r = await dialog.showOpenDialog(win!, { title: 'Import Roblox animation', properties: ['openFile'], filters: [{ name: 'Roblox KeyframeSequence', extensions: ['rbxmx'] }] })
      if (r.canceled || !r.filePaths[0]) return { ok: false }
      const rig = getRig(store.project)
      const seq = parseRbxmx(readFileSync(r.filePaths[0], 'utf8'))
      const { clip, skipped } = sequenceToClip(seq, rig, 30)
      if (!Object.keys(clip.tracks[rig.id] ?? {}).length) {
        return { ok: false, error: `None of the parts in this animation exist on "${rig.name}" (animation uses: ${skipped.slice(0, 8).join(', ')}). Select the matching rig first.` }
      }
      store.mutate('user', `imported animation "${clip.name}" from ${basename(r.filePaths[0])}`, (p) => {
        p.clips.push(clip)
        p.activeClipId = clip.id
      }, { clipId: clip.id })
      return { ok: true, path: r.filePaths[0], error: skipped.length ? `Imported. Skipped parts not on this rig: ${skipped.join(', ')}` : undefined }
    }
    return { ok: false, error: `Unknown action ${action}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function studioPluginsDir(): string {
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Roblox', 'Plugins')
    : join(homedir(), 'Documents', 'Roblox', 'Plugins')
}
function pluginSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'plugin', 'InbetweenStudio.lua') : join(app.getAppPath(), 'plugin', 'InbetweenStudio.lua')
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('doc:get', () => docState())
ipcMain.handle('cmd', (_e, cmd: UserCommand) => {
  try {
    runUserCommand(store, cmd)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
ipcMain.handle('file', (_e, action: string) => fileAction(action))
ipcMain.handle('file:read', (_e, path: string) => {
  // Only files the project itself references (rig meshes) may be read by the renderer.
  if (!store.project.rigs.some((r) => r.mesh?.path === path)) throw new Error('Not a project file.')
  return new Uint8Array(readFileSync(path))
})
ipcMain.handle('settings:get', () => settingsState())
ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
  const portChanged = patch.mcpPort !== undefined && patch.mcpPort !== settings.settings.mcpPort
  settings.update(patch)
  if (patch.theme) nativeTheme.themeSource = patch.theme
  if (portChanged) {
    ;(mcp as unknown as { opts: { port: number } }).opts.port = settings.settings.mcpPort
    await startMcp()
  }
  // Every window state that mirrors settings (model picker, theme, chat) updates from this push.
  pushSettings()
  return settingsState()
})
ipcMain.handle('key:set', async (_e, key: string | null) => {
  await settings.setKey(key)
  return settingsState()
})
ipcMain.handle('models:open', async () => {
  await shell.openPath(settings.modelsFile)
})
ipcMain.handle('copy', (_e, text: string) => clipboard.writeText(text))
ipcMain.handle('reveal', (_e, path: string) => shell.showItemInFolder(path))
ipcMain.handle('studio:install', () => {
  try {
    const dir = studioPluginsDir()
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, 'InbetweenStudio.lua')
    copyFileSync(pluginSource(), dest)
    return { ok: true, path: dest }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
ipcMain.handle('agent:send', (_e, text: string, view: ViewContext, worker?: string) => {
  void (worker ? workers.get(worker) : agent)?.send(text, view)
})
ipcMain.handle('agent:stop', (_e, worker?: string) => {
  if (worker) workers.get(worker)?.stop()
  else {
    agent.stop()
    for (const w of workers.values()) w.stop()
    // Stopping the AI also stops a video it is rendering.
    cancelRender('agent')
  }
})
ipcMain.handle('export:cancel', () => {
  cancelRender()
})
ipcMain.handle('agent:reset', () => agent.reset())
ipcMain.handle('agent:retry', (_e, worker?: string) => {
  void (worker ? workers.get(worker) : agent)?.retry()
})
ipcMain.handle('export:run', async (_e, args: Record<string, unknown>) => {
  let path = args.path as string | undefined
  if (!path && win) {
    const clip = getClip(store.project, args.clip as string | undefined)
    const ext = String(args.format)
    const r = await dialog.showSaveDialog(win, {
      defaultPath: host.resolveExportPath(`${clip.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'clip'}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return { ok: false }
    path = r.filePath
    if (!extname(path)) path += `.${ext}`
  }
  const res = await registry.call('export', { ...args, path }, 'mcp', 'ui')
  if (res.isError) return { ok: false, error: res.text.replace(/^export failed: /, '') }
  return { ok: true, path }
})
ipcMain.on('render:response', (_e, id: number, result: { ok: boolean; data?: Uint8Array | string; error?: string }) => {
  const p = pendingRenders.get(id)
  if (!p) return
  pendingRenders.delete(id)
  clearTimeout(p.timer)
  if (result.ok) p.resolve(result.data ?? '')
  else p.reject(new Error(result.error ?? 'Render failed'))
})
ipcMain.on('renderer:ready', () => {
  resolveReady?.()
  resolveReady = null
})
ipcMain.on('view', (_e, v: ViewContext) => {
  viewContext = v
})
void viewContext

// ---------------------------------------------------------------- window + menu

function menuSend(action: string): void {
  win?.webContents.send('menu', action)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  // Single-key shortcuts are handled by the window, which knows when a text field has focus. macOS ignores
  // registerAccelerator: false and would fire them from the menu on every keystroke, even while typing in the
  // chat box, so there the key is only shown in the label.
  const bare = (label: string, key: string, action: string): MenuItemConstructorOptions => (isMac
    ? { label: `${label}  (${key})`, click: () => menuSend(action) }
    : { label, accelerator: key, registerAccelerator: false, click: () => menuSend(action) })
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'Inbetween',
      submenu: [
        { role: 'about' as const }, { type: 'separator' as const },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => menuSend('settings') },
        { type: 'separator' as const }, { role: 'services' as const }, { type: 'separator' as const },
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => void fileAction('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void fileAction('open').then(reportFileResult) },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => void fileAction('save').then(reportFileResult) },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => void fileAction('saveAs').then(reportFileResult) },
        { type: 'separator' },
        { label: 'Import Model or Rig…', accelerator: 'CmdOrCtrl+I', click: () => void fileAction('importRig').then(reportFileResult) },
        { label: 'Import Roblox Animation…', click: () => void fileAction('importAnimation').then(reportFileResult) },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => menuSend('export') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Settings…', accelerator: 'Ctrl+,', click: () => menuSend('settings') }, { type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => menuSend('undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: () => menuSend('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        bare('Key Pose at Playhead', 'K', 'keyPose'),
        { label: 'Delete Keys at Playhead', click: () => menuSend('deleteKeys') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Chat', accelerator: 'CmdOrCtrl+\\', click: () => menuSend('toggleChat') },
        bare('Frame Rig', 'F', 'frame'),
        bare('First-Person View', 'V', 'firstPerson'),
        { type: 'separator' },
        { label: 'Theme', submenu: (['system', 'light', 'dark'] as const).map((t) => ({ label: t[0].toUpperCase() + t.slice(1), type: 'radio' as const, checked: settings.settings.theme === t, click: () => {
          settings.update({ theme: t })
          nativeTheme.themeSource = t
          pushSettings()
        } })) },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }, { role: 'reload' as const }])
      ]
    },
    {
      label: 'Playback',
      submenu: [
        bare('Play / Pause', 'Space', 'playPause'),
        bare('Previous Frame', 'Left', 'prevFrame'),
        bare('Next Frame', 'Right', 'nextFrame'),
        bare('Toggle Loop', 'L', 'toggleLoop')
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Install Roblox Studio Plugin', click: () => menuSend('installPlugin') },
        { label: 'Open Exports Folder', click: () => {
          mkdirSync(settings.settings.exportDir, { recursive: true })
          void shell.openPath(settings.settings.exportDir)
        } }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function reportFileResult(r: { ok: boolean; error?: string }): void {
  if (r.error) win?.webContents.send('toast', { message: r.error, kind: r.ok ? 'info' : 'error' })
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  rendererReady = new Promise((r) => (resolveReady = r))
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 880, minHeight: 560,
    show: false,
    title: 'Inbetween',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111113' : '#f4f4f2',
    // macOS: content under the title bar with inset traffic lights. Windows/Linux: the standard frame and menu bar.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // Previews and video frames must render even when the window is in the background.
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win?.show()
  })
  win.on('close', (e) => {
    if (quitting || !store.dirty) return
    e.preventDefault()
    void confirmDiscard().then((ok) => {
      if (ok) {
        store.dirty = false
        win?.close()
      }
    })
  })
  win.on('closed', () => {
    win = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  updateTitle()
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    const file = argv.find((a) => /\.inbetween$/i.test(a))
    if (file && existsSync(file)) openProjectFile(file)
  })
  app.on('open-file', (e, path) => {
    e.preventDefault()
    if (app.isReady()) openProjectFile(path)
    else app.once('ready', () => openProjectFile(path))
  })
  void app.whenReady().then(async () => {
    nativeTheme.themeSource = settings.settings.theme
    await settings.init()
    buildMenu()
    const fileArg = process.argv.find((a) => /\.inbetween$/i.test(a))
    if (fileArg && existsSync(fileArg)) openProjectFile(fileArg)
    createWindow()
    await startMcp()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  nativeTheme.on('updated', () => pushSettings())
  app.on('window-all-closed', () => {
    // macOS keeps the app (and its MCP server) running without a window; other platforms quit.
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (e) => {
    if (!quitting && store.dirty && win) {
      e.preventDefault()
      void confirmDiscard().then((ok) => {
        if (ok) {
          quitting = true
          app.quit()
        }
      })
      return
    }
    quitting = true
    rmSync(runtimeFile, { force: true })
    void mcp.stop()
  })
}
