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
      chatOpen: saved.chatOpen ?? true,
      effort: saved.effort
    }
    // Write the models file on first run. One earlier build briefly rewrote it with every model at high
    // effort; put that exact list back to the defaults. A file the person has edited is left alone.
    const existing = readJson<{ models?: ModelOption[] }>(this.modelsFile)
    const untouched = !!existing && JSON.stringify(existing.models) === JSON.stringify(DEFAULT_MODELS.map((m) => ({ ...m, effort: 'high' })))
    if (!existsSync(this.modelsFile) || untouched) {
      writeFileSync(this.modelsFile, JSON.stringify({
        _help: 'Models shown in the chat model picker. Add entries as {"id": "<Claude API model id>", "label": "<name>"}. Optional: "effort" (low|medium|high|xhigh|max, default medium; higher thinks longer and costs more; the Effort picker in the chat panel overrides it) and "fallbacks" (true to opt into server-side refusal fallbacks).',
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
    const m = list.find((x) => x.id === this.settings.model) ?? list[0]
    // The effort picked in the chat panel wins over the models file.
    return { ...m, effort: this.settings.effort ?? m.effort ?? 'medium' }
  }

  // --- API key: encrypted with the OS keychain via safeStorage, never logged, never sent to the renderer.

  private available = false

  /** Load keychain state. Call once after the app is ready. */
  async init(): Promise<void> {
    try {
      this.available = await safeStorage.isAsyncEncryptionAvailable()
    } catch {
      this.available = false
    }
    this.cachedKey = null
    if (!this.available || !existsSync(this.keyFile)) return
    try {
      const out = await safeStorage.decryptStringAsync(readFileSync(this.keyFile))
      this.cachedKey = out.result || null
      if (out.shouldReEncrypt && this.cachedKey) writeFileSync(this.keyFile, await safeStorage.encryptStringAsync(this.cachedKey), { mode: 0o600 })
    } catch {
      this.cachedKey = null
    }
  }

  get encryptionAvailable(): boolean {
    return this.available
  }

  getKey(): string | null {
    return this.cachedKey ?? null
  }

  async setKey(key: string | null): Promise<void> {
    const trimmed = key?.trim()
    if (!trimmed) {
      rmSync(this.keyFile, { force: true })
      this.cachedKey = null
      return
    }
    if (!this.available) throw new Error('This system has no secure credential storage available, so the key was not saved.')
    writeFileSync(this.keyFile, await safeStorage.encryptStringAsync(trimmed), { mode: 0o600 })
    this.cachedKey = trimmed
  }

  keyHint(): string {
    const k = this.getKey()
    return k ? `${k.slice(0, 7)}…${k.slice(-4)}` : ''
  }
}
