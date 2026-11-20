import { detectHead } from './rigSetup'
import { createClip, emptyProject } from './clip'
import { createR15 } from './r15'
import type { EditSource, Project } from './types'

export interface JournalEntry {
  seq: number
  source: EditSource
  /** Human/AI readable description of the change, e.g. "moved key RightHand frame 12 -> 14". */
  summary: string
  time: number
}

export interface StoreEvent {
  project: Project
  version: number
  /** What caused this state. */
  source: EditSource
  label: string
  canUndo: boolean
  canRedo: boolean
  /** Hints for the UI (which frames/bones just changed) so it can animate them. */
  touched?: Touched
}

export interface Touched {
  clipId?: string
  rigId?: string
  frames?: number[]
  bones?: string[]
}

interface UndoEntry {
  project: Project
  label: string
  source: EditSource
}

const clone = <T>(x: T): T => structuredClone(x)

/**
 * Owns the project document. Every mutation goes through `mutate`, which snapshots for
 * undo/redo and records a journal entry, so AI edits and manual edits share one history.
 */
export class ProjectStore {
  project: Project
  version = 0
  filePath: string | null = null
  dirty = false
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private listeners = new Set<(e: StoreEvent) => void>()
  private journal: JournalEntry[] = []
  private seq = 0
  private cursors = new Map<string, number>()
  maxUndo = 200

  constructor(project?: Project) {
    this.project = project ?? defaultProject()
  }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(source: EditSource, label: string, touched?: Touched): void {
    this.version++
    const e: StoreEvent = {
      project: this.project, version: this.version, source, label,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, touched
    }
    for (const fn of this.listeners) fn(e)
  }

  /** Apply a change. `fn` mutates the draft in place; throw to abort with no effect. */
  mutate<T>(source: EditSource, label: string, fn: (draft: Project) => T, touched?: Touched): T {
    const draft = clone(this.project)
    const result = fn(draft)
    this.undoStack.push({ project: this.project, label, source })
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
    this.redoStack = []
    this.project = draft
    this.dirty = true
    this.record(source, label)
    this.emit(source, label, touched)
    return result
  }

  /** Change view state (active clip/rig) without creating an undo step. */
  setActive(patch: { activeClipId?: string | null; activeRigId?: string | null }): void {
    this.project = { ...this.project, ...patch }
    this.emit('system', 'select')
  }

  undo(source: EditSource = 'user'): string | null {
    const e = this.undoStack.pop()
    if (!e) return null
    this.redoStack.push({ project: this.project, label: e.label, source: e.source })
    this.project = e.project
    this.dirty = true
    this.record(source, `undid: ${e.label}`)
    this.emit(source, `undo ${e.label}`)
    return e.label
  }

  redo(source: EditSource = 'user'): string | null {
    const e = this.redoStack.pop()
    if (!e) return null
    this.undoStack.push({ project: this.project, label: e.label, source: e.source })
    this.project = e.project
    this.dirty = true
    this.record(source, `redid: ${e.label}`)
    this.emit(source, `redo ${e.label}`)
    return e.label
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  load(project: Project, filePath: string | null): void {
    this.project = project
    this.filePath = filePath
    this.undoStack = []
    this.redoStack = []
    this.dirty = false
    this.journal = []
    this.cursors.clear()
    this.emit('system', 'load')
  }

  markSaved(filePath: string): void {
    this.filePath = filePath
    this.dirty = false
    this.emit('system', 'saved')
  }

  private record(source: EditSource, summary: string): void {
    this.journal.push({ seq: ++this.seq, source, summary, time: Date.now() })
    if (this.journal.length > 500) this.journal.shift()
  }

  /**
   * Manual edits a given AI consumer has not been told about yet. Calling this advances that
   * consumer's cursor, so each edit is reported exactly once per consumer.
   */
  takeUserEdits(consumer: string): string[] {
    const from = this.cursors.get(consumer) ?? 0
    this.cursors.set(consumer, this.seq)
    return this.journal.filter((j) => j.seq > from && j.source === 'user').map((j) => j.summary)
  }

  /** Start a consumer at "now" so it is only told about edits made after it joined. */
  touchConsumer(consumer: string): void {
    if (!this.cursors.has(consumer)) this.cursors.set(consumer, this.seq)
  }
}

export function defaultProject(): Project {
  const p = emptyProject('Untitled')
  const rig = createR15('r15', 'R15')
  const clip = createClip('Clip 1', 30, 30, false)
  p.rigs.push(rig)
  p.clips.push(clip)
  p.activeClipId = clip.id
  p.activeRigId = rig.id
  return p
}

export function parseProject(text: string): Project {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON.')
  }
  const p = data as Partial<Project>
  if (!p || p.format !== 'inbetween' || !Array.isArray(p.rigs) || !Array.isArray(p.clips)) {
    throw new Error('This file is not an Inbetween project.')
  }
  if (p.version !== 1) throw new Error(`Unsupported project version ${String(p.version)}.`)
  for (const c of p.clips) {
    c.tracks ??= {}
    c.ikTracks ??= {}
    c.contacts ??= []
    c.markers ??= []
    c.camera ??= []
  }
  p.poses ??= {}
  // Rigs imported before head detection covered their naming get a head (and so a first-person view) now.
  for (const r of p.rigs) if (!r.head && Array.isArray(r.bones)) r.head = detectHead(r)
  return p as Project
}

export const serializeProject = (p: Project): string => JSON.stringify(p, null, 1)
