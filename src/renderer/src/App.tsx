import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { useEffect } from 'react'
import type { AgentEvent } from '../../shared/api'
import { renderContactSheet, videoBegin, videoEnd, videoFrame } from './stage/offscreen'
import { THEMES } from './stage/Stage'
import { activeClip, api, command, useStore, type ChatMessage } from './store'
import { Chat } from './ui/Chat'
import { IconCheck } from './ui/icons'
import { ExportSheet, SettingsSheet } from './ui/Sheets'
import { Timeline } from './ui/Timeline'
import { SelectionPill, TopBar } from './ui/TopBar'
import { Viewport, viewportActions } from './ui/Viewport'

const spring = { type: 'spring' as const, stiffness: 460, damping: 30 }

/** Fold streamed agent events into the chat transcript. */
function reduceAgent(messages: ChatMessage[], e: AgentEvent): ChatMessage[] {
  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage): ChatMessage[] => messages.map((m) => (m.id === id ? fn(m) : m))
  const patchTool = (toolId: string, fn: (t: Extract<ChatMessage['parts'][number], { kind: 'tool' }>['tool']) => typeof t): ChatMessage[] =>
    messages.map((m) => (m.parts.some((p) => p.kind === 'tool' && p.tool.toolId === toolId)
      ? { ...m, parts: m.parts.map((p) => (p.kind === 'tool' && p.tool.toolId === toolId ? { kind: 'tool' as const, tool: fn(p.tool) } : p)) }
      : m))
  switch (e.type) {
    case 'assistant_start':
      return [...messages, { id: e.id, role: 'assistant', parts: [], streaming: true }]
    case 'text':
      return patch(e.id, (m) => {
        const last = m.parts[m.parts.length - 1]
        if (last?.kind === 'text') return { ...m, parts: [...m.parts.slice(0, -1), { kind: 'text', text: last.text + e.delta }] }
        return { ...m, parts: [...m.parts, { kind: 'text', text: e.delta }] }
      })
    case 'thinking':
      return patch(e.id, (m) => ({ ...m, thinking: (m.thinking ?? '') + e.delta }))
    case 'tool_start':
      return patch(e.id, (m) => ({ ...m, parts: [...m.parts, { kind: 'tool', tool: { toolId: e.toolId, name: e.name, chip: e.chip, status: 'running' } }] }))
    case 'tool_label':
      return patchTool(e.toolId, (t) => ({ ...t, chip: e.chip }))
    case 'tool_end':
      return patchTool(e.toolId, (t) => ({ ...t, status: e.isError ? 'error' : 'done', image: e.image, summary: e.summary }))
    case 'usage':
      return patch(e.id, (m) => ({ ...m, usage: e.usage, model: e.model, streaming: false }))
    case 'error':
      return [...messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)), { id: `e${Date.now()}`, role: 'error', text: e.message, parts: [], errorKind: e.kind, retryable: e.retryable }]
    case 'turn_end':
      return messages.filter((m) => m.role !== 'assistant' || m.parts.length).map((m) => ({
        ...m, streaming: false,
        parts: m.parts.map((p) => (p.kind === 'tool' && p.tool.status === 'running' ? { kind: 'tool' as const, tool: { ...p.tool, status: 'error' as const, summary: 'stopped' } } : p))
      }))
    case 'reset':
      return []
    default:
      return messages
  }
}

function useWiring(): void {
  useEffect(() => {
    const S = useStore.getState
    const offs: (() => void)[] = []
    void api.getDoc().then((doc) => S().set({ doc }))
    void api.getSettings().then((settings) => S().set({ settings, chatOpen: settings.settings.chatOpen }))
    offs.push(api.onDoc((doc) => {
      const s = S()
      const clip = doc.project.clips.find((c) => c.id === doc.project.activeClipId)
      const patch: Parameters<typeof s.set>[0] = { doc }
      if (clip && s.frame > clip.length) patch.frame = clip.length
      // Follow the AI: jump to the frame it just posed so the change is visible as it lands.
      if ((doc.source === 'agent' || doc.source === 'mcp') && doc.touched?.frames?.length && !s.playing) patch.frame = doc.touched.frames[doc.touched.frames.length - 1]
      if (doc.label === 'load') Object.assign(patch, { frame: 0, playing: false, selectedBone: null, selectedChain: null, selectedKeys: [] })
      s.set(patch)
    }))
    offs.push(api.onSettings((settings) => S().set({ settings })))
    offs.push(api.onAgent((e) => {
      const s = S()
      if (e.type === 'turn_start') s.set({ agentBusy: true })
      else if (e.type === 'turn_end') s.set({ agentBusy: false, messages: reduceAgent(s.messages, e) })
      else s.set({ messages: reduceAgent(s.messages, e) })
    }))
    offs.push(api.onTool((e) => {
      // Tool calls from outside the chat panel (MCP clients) show as floating chips.
      if (e.source !== 'mcp' || e.name === 'export') return
      const s = S()
      if (e.phase === 'start') s.set({ activity: [...s.activity.filter((a) => a.id !== e.id).slice(-4), { ...e, at: Date.now() }] })
      else {
        s.set({ activity: s.activity.map((a) => (a.id === e.id ? { ...a, ...e } : a)) })
        setTimeout(() => S().set({ activity: S().activity.filter((a) => a.id !== e.id) }), 1500)
      }
    }))
    offs.push(api.onExportProgress((p) => S().set({ exportProgress: p.active ? p : null })))
    offs.push(api.onToast((t) => S().toast(t.message, t.kind === 'error' ? 'error' : 'info')))
    offs.push(api.onRenderRequest((id, r) => {
      const colors = THEMES[S().resolvedTheme]
      const read = (p: string): Promise<Uint8Array> => api.readFile(p)
      const done = (data?: Uint8Array | string): void => api.renderResponse(id, { ok: true, data })
      const fail = (err: unknown): void => api.renderResponse(id, { ok: false, error: err instanceof Error ? err.message : String(err) })
      try {
        if (r.kind === 'preview') renderContactSheet(r.req, colors, read).then(done, fail)
        else if (r.kind === 'videoBegin') videoBegin(r.req, colors, read).then(() => done(), fail)
        else if (r.kind === 'videoFrame') done(videoFrame(r.time))
        else {
          videoEnd()
          done()
        }
      } catch (err) {
        fail(err)
      }
    }))

    const act = (action: string): void => {
      const s = S()
      const clip = activeClip(s)
      const frame = Math.round(s.frame)
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement?.tagName ?? '').toUpperCase())
      switch (action) {
        case 'undo':
          // In a text field, undo belongs to the text.
          if (typing) document.execCommand('undo')
          else void command({ type: 'undo' })
          break
        case 'redo':
          if (typing) document.execCommand('redo')
          else void command({ type: 'redo' })
          break
        case 'settings': s.set({ sheet: 'settings' }); break
        case 'export': s.set({ sheet: 'export' }); break
        case 'toggleChat':
          s.set({ chatOpen: !s.chatOpen })
          void api.setSettings({ chatOpen: !s.chatOpen })
          break
        case 'frame': viewportActions.frameRig?.(); break
        case 'firstPerson': s.set({ firstPerson: s.firstPerson === false ? 'first_person' : s.firstPerson === 'first_person' ? 'head_cam' : false }); break
        case 'playPause': s.set({ playing: !s.playing, frame: !s.playing && clip && s.frame >= clip.length ? 0 : s.frame }); break
        case 'prevFrame': s.set({ playing: false, frame: Math.max(0, frame - 1) }); break
        case 'nextFrame': s.set({ playing: false, frame: Math.min(clip?.length ?? 0, frame + 1) }); break
        case 'toggleLoop': if (clip) void command({ type: 'updateClip', patch: { loop: !clip.loop } }); break
        case 'keyPose': void command({ type: 'keyPose', frame }); break
        case 'deleteKeys': {
          const frames = s.selectedKeys.length ? s.selectedKeys : [frame]
          void command({ type: 'deleteKeys', frames })
          s.set({ selectedKeys: [] })
          break
        }
        case 'installPlugin':
          void api.installStudioPlugin().then((r) => S().toast(r.ok ? 'Plugin installed. Restart Roblox Studio to load it.' : `Could not install the plugin: ${r.error}`, r.ok ? 'info' : 'error', r.path))
          break
      }
    }
    offs.push(api.onMenu(act))

    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? ''
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const s = S()
      const map: Record<string, string> = { ' ': 'playPause', ArrowLeft: 'prevFrame', ArrowRight: 'nextFrame', l: 'toggleLoop', k: 'keyPose', f: 'frame' }
      if (e.key === 'Escape') {
        if (s.sheet) s.set({ sheet: null })
        else if (s.lightbox) s.set({ lightbox: null })
        else if (s.firstPerson) s.set({ firstPerson: false })
        else s.set({ selectedBone: null, selectedChain: null, selectedKeys: [] })
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedKeys.length) act('deleteKeys')
      else if (e.key === 'v') s.set({ firstPerson: s.firstPerson === false ? 'first_person' : s.firstPerson === 'first_person' ? 'head_cam' : false })
      else if (e.key === 'r') s.set({ gizmo: 'rotate' })
      else if (e.key === 'g' || e.key === 'w') s.set({ gizmo: 'move' })
      else if (map[e.key]) act(map[e.key])
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)

    // Theme: the main process resolves the setting against the OS preference and tells us.
    const applyTheme = (dark: boolean): void => {
      const t = dark ? 'dark' : 'light'
      document.documentElement.dataset.theme = t
      if (S().resolvedTheme !== t) S().set({ resolvedTheme: t })
    }
    applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches)
    const unsubTheme = useStore.subscribe((s, p) => {
      if (s.settings && s.settings.dark !== p.settings?.dark) applyTheme(s.settings.dark)
    })

    // Tell the main process what the user is looking at, for the agent's context.
    const unsub = useStore.subscribe((s, p) => {
      if (Math.round(s.frame) !== Math.round(p.frame) || s.selectedBone !== p.selectedBone) api.setViewContext({ frame: Math.round(s.frame), selectedBone: s.selectedBone })
    })
    api.ready()
    return () => {
      offs.forEach((f) => f())
      unsub()
      window.removeEventListener('keydown', onKey)
      unsubTheme()
    }
  }, [])
}

export function App(): React.JSX.Element {
  useWiring()
  const chatOpen = useStore((s) => s.chatOpen)
  const sheet = useStore((s) => s.sheet)
  const toasts = useStore((s) => s.toasts)
  const activity = useStore((s) => s.activity)
  const progress = useStore((s) => s.exportProgress)
  const lightbox = useStore((s) => s.lightbox)
  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <Viewport />
        <TopBar />
        <SelectionPill />
        <div className="activity" aria-live="polite">
          <AnimatePresence>
            {activity.map((a) => (
              <motion.span key={a.id} layout className={`chip ${a.phase === 'start' ? 'running' : a.isError ? 'error' : 'done'}`}
                initial={{ opacity: 0, x: -14, scale: 0.9 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -8, scale: 0.94 }} transition={spring}>
                {a.phase === 'start' ? <span className="dot" /> : <IconCheck />}{a.chip}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
        <AnimatePresence>{chatOpen && <Chat key="chat" />}</AnimatePresence>
        <Timeline />
        <AnimatePresence>
          {progress && sheet !== 'export' && (
            <motion.div key="exp" className="export-float panel" initial={{ opacity: 0, y: -12, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: -8, x: '-50%' }} transition={spring}>
              <span>{progress.label}, {Math.round(progress.progress * 100)}%</span>
              <div className="progress"><motion.i animate={{ scaleX: Math.max(0.02, progress.progress) }} transition={{ type: 'spring', stiffness: 200, damping: 30 }} /></div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="toasts" aria-live="polite">
          <AnimatePresence>
            {toasts.map((t) => (
              <motion.div key={t.id} layout className={`toast panel ${t.kind}`} initial={{ opacity: 0, y: 16, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.96 }} transition={spring}>
                <span>{t.message}</span>
                {t.path && <button onClick={() => void api.reveal(t.path!)}>Show</button>}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <AnimatePresence>
          {sheet === 'settings' && <SettingsSheet key="settings" />}
          {sheet === 'export' && <ExportSheet key="export" />}
        </AnimatePresence>
        <AnimatePresence>
          {lightbox && (
            <motion.div key="lb" className="lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => useStore.getState().set({ lightbox: null })}>
              <motion.img alt="Preview contact sheet" src={`data:image/png;base64,${lightbox}`} initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} transition={spring} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )
}
