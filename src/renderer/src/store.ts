import { create } from 'zustand'
import type { Clip, Rig } from '@core/types'
import type { AgentErrorKind, DocState, ExportProgress, InbetweenApi, SettingsState, ToolEvent, Usage } from '../../shared/api'

export const api = (window as unknown as { inbetween: InbetweenApi & { onToast(fn: (t: { message: string; kind: string }) => void): () => void; ready(): void } }).inbetween

export interface ChatTool {
  toolId: string
  name: string
  chip: string
  status: 'running' | 'done' | 'error'
  image?: string
  summary?: string
}
export type ChatPart = { kind: 'text'; text: string } | { kind: 'tool'; tool: ChatTool }
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  text?: string
  parts: ChatPart[]
  thinking?: string
  streaming?: boolean
  usage?: Usage
  model?: string
  errorKind?: AgentErrorKind
  retryable?: boolean
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error' | 'activity'
  path?: string
}

interface State {
  doc: DocState | null
  settings: SettingsState | null
  /** Playhead position in frames (fractional while playing). */
  frame: number
  playing: boolean
  speed: number
  selectedBone: string | null
  selectedChain: string | null
  gizmo: 'rotate' | 'move'
  /** Look through the active rig's eyes instead of the orbit camera. */
  firstPerson: false | 'first_person' | 'head_cam'
  selectedKeys: number[]
  /** key frames that should play their pop-in animation, with the time they arrived */
  popped: Record<number, number>
  chatOpen: boolean
  sheet: 'settings' | 'export' | null
  messages: ChatMessage[]
  agentBusy: boolean
  /** external (MCP) tool activity shown as floating chips */
  activity: (ToolEvent & { at: number })[]
  toasts: Toast[]
  exportProgress: ExportProgress | null
  lightbox: string | null
  resolvedTheme: 'light' | 'dark'
  set(patch: Partial<State>): void
  toast(message: string, kind?: Toast['kind'], path?: string): void
}

let toastSeq = 0

export const useStore = create<State>((set, get) => ({
  doc: null, settings: null, frame: 0, playing: false, speed: 1, selectedBone: null, selectedChain: null, gizmo: 'rotate', firstPerson: false,
  selectedKeys: [], popped: {}, chatOpen: true, sheet: null, messages: [], agentBusy: false, activity: [], toasts: [],
  exportProgress: null, lightbox: null, resolvedTheme: 'dark',
  set: (patch) => set(patch),
  toast: (message, kind = 'info', path) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts.slice(-3), { id, message, kind, path }] })
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 4200)
  }
}))

export const activeClip = (s: { doc: DocState | null }): Clip | undefined => s.doc?.project.clips.find((c) => c.id === s.doc!.project.activeClipId)
export const activeRig = (s: { doc: DocState | null }): Rig | undefined => s.doc?.project.rigs.find((r) => r.id === s.doc!.project.activeRigId) ?? s.doc?.project.rigs[0]

export const isMac = api.platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl+'

export async function command(cmd: Parameters<InbetweenApi['command']>[0]): Promise<boolean> {
  const r = await api.command(cmd)
  if (!r.ok && r.error) useStore.getState().toast(r.error, 'error')
  return r.ok
}

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
