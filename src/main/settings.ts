import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelOption, Settings } from '../shared/api'
import { DEFAULT_MODELS } from './agent'

export const DEFAULT_PORT = 47821

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export class SettingsStore {
  private dir = app.getPath('userData')
  private file = join(this.dir, 'settings.json')
  readonly modelsFile = join(this.dir, 'models.json')
  private keyFile = join(this.dir, 'api-key.bin')
  settings: Settings
  private cachedKey: string | null | undefined

  constructor() {
    mkdirSync(this.dir, { recursive: true })
    const saved = readJson<Partial<Settings>>(this.file) ?? {}
    this.settings = {
      theme: saved.theme ?? 'system',
      model: saved.model ?? DEFAULT_MODELS[0].id,
      mcpPort: saved.mcpPort ?? DEFAULT_PORT,
      exportDir: saved.exportDir ?? join(app.getPath('documents'), 'Inbetween', 'exports'),
      chatOpen: saved.chatOpen ?? true
    }
    if (!existsSync(this.modelsFile)) {
      writeFileSync(this.modelsFile, JSON.stringify({
        _help: 'Models shown in the chat model picker. Add entries as {"id": "<Claude API model id>", "label": "<name>"}. Optional: "effort" (low|medium|high|xhigh|max, default medium) and "fallbacks" (true to opt into server-side refusal fallbacks).',
        models: DEFAULT_MODELS
      }, null, 2))
    }
  }

  update(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch }
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2))
  }

  /** The model list is re-read on every use so edits to models.json apply without a restart. */
  models(): ModelOption[] {
    const data = readJson<{ models?: ModelOption[] }>(this.modelsFile)
    const list = (data?.models ?? []).filter((m) => m && typeof m.id === 'string' && m.id.trim())
      .map((m) => ({ ...m, label: m.label || m.id }))
    return list.length ? list : DEFAULT_MODELS
  }

  currentModel(): ModelOption {
    const list = this.models()
    return list.find((m) => m.id === this.settings.model) ?? list[0]
  }

  // --- API key: encrypted with the OS keychain via safeStorage, never logged, never sent to the renderer.

  get encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  getKey(): string | null {
    if (this.cachedKey !== undefined) return this.cachedKey
    try {
      if (!existsSync(this.keyFile) || !this.encryptionAvailable) return (this.cachedKey = null)
      this.cachedKey = safeStorage.decryptString(readFileSync(this.keyFile))
    } catch {
      this.cachedKey = null
    }
    return this.cachedKey
  }

  setKey(key: string | null): void {
    const trimmed = key?.trim()
    if (!trimmed) {
      rmSync(this.keyFile, { force: true })
      this.cachedKey = null
      return
    }
    if (!this.encryptionAvailable) throw new Error('This system has no secure credential storage available, so the key was not saved.')
    writeFileSync(this.keyFile, safeStorage.encryptString(trimmed), { mode: 0o600 })
    this.cachedKey = trimmed
  }

  keyHint(): string {
    const k = this.getKey()
    return k ? `${k.slice(0, 7)}…${k.slice(-4)}` : ''
  }
}
