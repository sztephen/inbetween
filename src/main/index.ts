import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { getClip, getRig, newId } from '../core/clip'
import { defaultProject, parseProject, ProjectStore, serializeProject } from '../core/document'
import { clipToSequence, parseRbxmx, sequenceToClip } from '../core/export/rbxmx'
import { importGlbRig } from '../core/import/gltf'
import { importRobloxRig } from '../core/import/robloxRig'
import { buildTools } from '../core/tools'
import { ToolRegistry, type ToolHost, type ToolImage } from '../core/tools/registry'
import type { Rig } from '../core/types'
import workflow from '../core/workflow.md?raw'
import type { DocState, ExportProgress, McpInfo, RenderRequest, Settings, SettingsState, UserCommand, ViewContext } from '../shared/api'
import { AgentSession, createClient } from './agent'
import { McpHost, newToken } from './mcp'
import { SettingsStore } from './settings'
import { runUserCommand } from './userCommands'
import { encodeVideo } from './video'

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
    sendExportProgress({ active: true, label, progress: 0 })
    try {
      await renderInWindow({ kind: 'videoBegin', req: { ...req, width, height }, frames: total })
      const frames = await encodeVideo(
        { format: req.format, path: req.path, width, height, fps: req.fps, transparent: req.background === 'transparent' },
        async (i) => {
          if (i >= total) return null
          const data = await renderInWindow({ kind: 'videoFrame', index: i, time: i / req.fps })
          sendExportProgress({ active: true, label, progress: (i + 1) / total })
          return data as Uint8Array
        })
      sendExportProgress({ active: false, label: 'Exported', progress: 1, path: req.path })
      return { path: req.path, frames }
    } catch (err) {
      sendExportProgress({ active: false, label: 'Export failed', progress: 0, error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      await renderInWindow({ kind: 'videoEnd' }).catch(() => undefined)
    }
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

const agent = new AgentSession({
  registry,
  system: SYSTEM_PROMPT,
  getClient: () => {
    if (mockApi) return createClient(settings.getKey() ?? 'mock-key', mockApi)
    const key = settings.getKey()
    return key ? createClient(key) : null
  },
  getModel: () => settings.currentModel(),
  emit: (e) => win?.webContents.send('agent:event', e)
})

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
        title: 'Import rig', properties: ['openFile'],
        filters: [{ name: 'Rigs (glTF, Roblox rig JSON)', extensions: ['glb', 'gltf', 'json'] }]
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
ipcMain.handle('agent:send', (_e, text: string, view: ViewContext) => {
  void agent.send(text, view)
})
ipcMain.handle('agent:stop', () => agent.stop())
ipcMain.handle('agent:reset', () => agent.reset())
ipcMain.handle('agent:retry', () => {
  void agent.retry()
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
        { label: 'Import Rig…', click: () => void fileAction('importRig').then(reportFileResult) },
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
        { label: 'Key Pose at Playhead', accelerator: 'K', registerAccelerator: false, click: () => menuSend('keyPose') },
        { label: 'Delete Keys at Playhead', click: () => menuSend('deleteKeys') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Chat', accelerator: 'CmdOrCtrl+\\', click: () => menuSend('toggleChat') },
        { label: 'Frame Rig', accelerator: 'F', registerAccelerator: false, click: () => menuSend('frame') },
        { label: 'First-Person View', accelerator: 'V', registerAccelerator: false, click: () => menuSend('firstPerson') },
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
        { label: 'Play / Pause', accelerator: 'Space', registerAccelerator: false, click: () => menuSend('playPause') },
        { label: 'Previous Frame', accelerator: 'Left', registerAccelerator: false, click: () => menuSend('prevFrame') },
        { label: 'Next Frame', accelerator: 'Right', registerAccelerator: false, click: () => menuSend('nextFrame') },
        { label: 'Toggle Loop', accelerator: 'L', registerAccelerator: false, click: () => menuSend('toggleLoop') }
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
