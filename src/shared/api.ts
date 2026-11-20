// Types shared by the main process, the preload bridge and the renderer.
import type { Touched } from '../core/document'
import type { PreviewRequest, VideoRequest } from '../core/tools/registry'
import type { Project, Quat, Vec3 } from '../core/types'

export interface DocState {
  project: Project
  version: number
  source: 'user' | 'agent' | 'mcp' | 'system'
  label: string
  canUndo: boolean
  canRedo: boolean
  filePath: string | null
  dirty: boolean
  touched?: Touched
}

export type UserCommand =
  | { type: 'setBone'; frame: number; bone: string; q: Quat; p?: Vec3 }
  | { type: 'dragIK'; frame: number; chain: string; position: Vec3 }
  | { type: 'moveKeys'; moves: { from: number; to: number }[]; copy?: boolean }
  | { type: 'deleteKeys'; frames: number[] }
  | { type: 'setEasing'; frames: number[]; preset: string }
  | { type: 'keyPose'; frame: number }
  | { type: 'updateClip'; patch: { name?: string; length?: number; fps?: number; loop?: boolean } }
  | { type: 'newClip'; name: string }
  | { type: 'setActive'; clipId?: string; rigId?: string }
  | { type: 'undo' }
  | { type: 'redo' }

export interface ToolEvent {
  phase: 'start' | 'end'
  id: string
  name: string
  chip: string
  source: 'agent' | 'mcp'
  isError?: boolean
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type AgentErrorKind = 'no_key' | 'auth' | 'rate_limit' | 'network' | 'overloaded' | 'bad_request' | 'model' | 'refusal' | 'truncated' | 'unknown'

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'assistant_start'; id: string }
  | { type: 'text'; id: string; delta: string }
  | { type: 'thinking'; id: string; delta: string }
  | { type: 'tool_start'; id: string; toolId: string; name: string; chip: string }
  | { type: 'tool_label'; toolId: string; chip: string }
  | { type: 'tool_end'; toolId: string; isError: boolean; summary: string; image?: string }
  | { type: 'usage'; id: string; usage: Usage; model: string }
  | { type: 'error'; kind: AgentErrorKind; message: string; retryable: boolean }
  | { type: 'turn_end'; turn: number; stopped?: boolean }
  | { type: 'reset' }

export interface ModelOption {
  id: string
  label: string
  /** output_config.effort; thinking is adaptive. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Opt into server-side refusal fallbacks (beta) for this model. */
  fallbacks?: boolean
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  model: string
  mcpPort: number
  exportDir: string
  chatOpen: boolean
}

export interface SettingsState {
  settings: Settings
  models: ModelOption[]
  modelsFile: string
  hasKey: boolean
  keyHint: string
  encryptionAvailable: boolean
  /** Resolved theme after applying the setting to the OS preference. */
  dark: boolean
  platform: NodeJS.Platform
  mcp: McpInfo
  version: string
}

export interface McpInfo {
  running: boolean
  port: number
  url: string
  /** Ready-to-paste configs. */
  claudeCodeCommand: string
  httpConfig: string
  stdioConfig: string
  clients: number
  error?: string
}

export interface ViewContext {
  frame: number
  selectedBone: string | null
}

export type RenderRequest =
  | { kind: 'preview'; req: PreviewRequest }
  | { kind: 'videoBegin'; req: VideoRequest; frames: number }
  | { kind: 'videoFrame'; index: number; time: number }
  | { kind: 'videoEnd' }

export interface ExportProgress {
  active: boolean
  label: string
  progress: number
  path?: string
  error?: string
}

export interface InbetweenApi {
  platform: NodeJS.Platform
  getDoc(): Promise<DocState>
  onDoc(fn: (d: DocState) => void): () => void
  command(cmd: UserCommand): Promise<{ ok: boolean; error?: string }>
  file(action: 'new' | 'open' | 'save' | 'saveAs' | 'importRig' | 'importAnimation'): Promise<{ ok: boolean; error?: string; path?: string }>
  readFile(path: string): Promise<Uint8Array>
  getSettings(): Promise<SettingsState>
  setSettings(patch: Partial<Settings>): Promise<SettingsState>
  onSettings(fn: (s: SettingsState) => void): () => void
  setApiKey(key: string | null): Promise<SettingsState>
  openModelsFile(): Promise<void>
  copy(text: string): Promise<void>
  installStudioPlugin(): Promise<{ ok: boolean; path?: string; error?: string }>
  reveal(path: string): Promise<void>
  agentSend(text: string, view: ViewContext): Promise<void>
  agentStop(): Promise<void>
  agentReset(): Promise<void>
  agentRetry(): Promise<void>
  onAgent(fn: (e: AgentEvent) => void): () => void
  onTool(fn: (e: ToolEvent) => void): () => void
  exportClip(args: Record<string, unknown>): Promise<{ ok: boolean; path?: string; error?: string }>
  onExportProgress(fn: (p: ExportProgress) => void): () => void
  onRenderRequest(fn: (id: number, r: RenderRequest) => void): () => void
  renderResponse(id: number, result: { ok: boolean; data?: Uint8Array | string; error?: string }): void
  onMenu(fn: (action: string) => void): () => void
  setViewContext(view: ViewContext): void
}
