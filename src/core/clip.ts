import { ease } from './easing'
import { solveChain } from './ik'
import { qid, qslerp, vadd, vlerp, vscale, xmul, type Quat, type Vec3 } from './math'
import { computeWorld, getChain, rigBounds, restWorld, scaleRig, type WorldPose } from './rig'
import type { CameraKey, Clip, Contact, EaseDir, EaseStyle, IKKey, Key, Pose, Project, Rig } from './types'

let idCounter = 0
export function newId(prefix: string): string {
  idCounter++
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export function createClip(name: string, length = 30, fps = 30, loop = false): Clip {
  return {
    id: newId('clip'), name, length, fps, loop, priority: 'Action',
    tracks: {}, ikTracks: {}, contacts: [], markers: [], camera: []
  }
}

export function emptyProject(name = 'Untitled'): Project {
  return { format: 'inbetween', version: 1, name, rigs: [], clips: [], poses: {}, activeClipId: null, activeRigId: null }
}

// ---------- key access ----------

/** Index of the last key with key.frame <= frame, or -1. */
export function keyIndexAt<T extends { frame: number }>(keys: T[], frame: number): number {
  let lo = 0, hi = keys.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid].frame <= frame) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

export function upsertKey<T extends { frame: number }>(keys: T[], key: T): void {
  const i = keyIndexAt(keys, key.frame)
  if (i >= 0 && keys[i].frame === key.frame) keys[i] = key
  else keys.splice(i + 1, 0, key)
}

export function removeKeyAt<T extends { frame: number }>(keys: T[], frame: number): boolean {
  const i = keys.findIndex((k) => k.frame === frame)
  if (i < 0) return false
  keys.splice(i, 1)
  return true
}

export function sampleTrack(keys: Key[] | undefined, frame: number): { q: Quat; p?: Vec3 } | undefined {
  if (!keys || keys.length === 0) return undefined
  const i = keyIndexAt(keys, frame)
  if (i < 0) return { q: keys[0].q, p: keys[0].p }
  const a = keys[i]
  if (i === keys.length - 1 || a.frame === frame) return { q: a.q, p: a.p }
  const b = keys[i + 1]
  const t = ease(a.ease, a.dir, (frame - a.frame) / (b.frame - a.frame))
  const q = qslerp(a.q, b.q, t)
  if (a.p || b.p) return { q, p: vlerp(a.p ?? [0, 0, 0], b.p ?? [0, 0, 0], t) }
  return { q }
}

/** Pose from bone tracks only (no IK tracks, no contacts). */
export function sampleFK(clip: Clip, rig: Rig, frame: number): Pose {
  const pose: Pose = {}
  const tracks = clip.tracks[rig.id]
  if (!tracks) return pose
  for (const b of rig.bones) {
    const s = sampleTrack(tracks[b.name], frame)
    if (s) pose[b.name] = s
  }
  return pose
}

function sampleIK(keys: IKKey[], frame: number): { position: Vec3; rotation?: Quat; pole?: Vec3 } | undefined {
  if (keys.length < 1) return undefined
  if (frame < keys[0].frame || frame > keys[keys.length - 1].frame) return undefined
  const i = keyIndexAt(keys, frame)
  const a = keys[i]
  if (i === keys.length - 1 || a.frame === frame) return { position: a.position, rotation: a.rotation, pole: a.pole }
  const b = keys[i + 1]
  const t = ease(a.ease, a.dir, (frame - a.frame) / (b.frame - a.frame))
  return {
    position: vlerp(a.position, b.position, t),
    rotation: a.rotation && b.rotation ? qslerp(a.rotation, b.rotation, t) : (a.rotation ?? b.rotation),
    pole: a.pole && b.pole ? vlerp(a.pole, b.pole, t) : (a.pole ?? b.pole)
  }
}

export function contactTarget(c: Contact, frame: number): Vec3 {
  if (!c.slide || c.end <= c.start) return c.position
  const t = Math.min(1, Math.max(0, (frame - c.start) / (c.end - c.start)))
  return vadd(c.position, vscale(c.slide, t))
}

export const contactsAt = (clip: Clip, rigId: string, frame: number): Contact[] =>
  clip.contacts.filter((c) => c.rig === rigId && frame >= c.start && frame <= c.end)

/** True when the evaluated pose at this frame differs from plain key interpolation (IK track or contact active). */
export function isConstrainedFrame(clip: Clip, rigId: string, frame: number): boolean {
  if (clip.contacts.some((c) => c.rig === rigId && frame >= c.start && frame <= c.end)) return true
  const ik = clip.ikTracks[rigId]
  if (ik) for (const ch in ik) {
    const k = ik[ch]
    if (k.length > 1 && frame >= k[0].frame && frame <= k[k.length - 1].frame) return true
  }
  return false
}

/**
 * Final pose of a rig at a frame: bone tracks, then IK-target tracks, then contacts.
 * Fractional frames are allowed (playback).
 */
export function evaluateRig(clip: Clip, rig: Rig, frame: number, opts: { skipContacts?: boolean } = {}): Pose {
  const pose = sampleFK(clip, rig, frame)
  const ik = clip.ikTracks[rig.id]
  if (ik) {
    for (const chainName in ik) {
      const keys = ik[chainName]
      if (keys.length < 2) continue
      const t = sampleIK(keys, frame)
      const chain = rig.chains.find((c) => c.name === chainName)
      if (t && chain) solveChain(rig, pose, chain, t)
    }
  }
  if (!opts.skipContacts) {
    for (const c of clip.contacts) {
      if (c.rig !== rig.id || frame < c.start || frame > c.end) continue
      const chain = rig.chains.find((x) => x.name === c.chain)
      if (chain) solveChain(rig, pose, chain, { position: contactTarget(c, frame), rotation: c.rotation })
    }
  }
  return pose
}

/**
 * The rig as it stands at a frame: the same rig, unless an attachment is carrying it, in which case
 * a copy placed on the bone it is attached to. Evaluate and draw attached rigs through this.
 */
export function rigAtFrame(rigs: Rig[], clip: Clip | undefined, rig: Rig, frame: number, depth = 0): Rig {
  const a = clip?.attachments?.find((x) => x.rig === rig.id && frame >= x.start && frame <= x.end)
  if (!a || depth > 4) return rig
  const carrier = rigs.find((r) => r.id === a.toRig)
  if (!carrier || carrier.id === rig.id) return rig
  const c = rigAtFrame(rigs, clip, carrier, frame, depth + 1)
  const bone = computeWorld(c, evaluateRig(clip!, c, frame)).bone[a.toBone]
  if (!bone) return rig
  return { ...rig, origin: xmul(bone, a.offset) }
}

/** Metres to Roblox studs (one stud is 0.28 m). */
export const STUDS_PER_METER = 1 / 0.28

/**
 * Make a newly imported rig sit sensibly in the scene: convert a metre-sized model to studs when the
 * scene is in studs (unless a scale was chosen), and stand it beside what is already there instead of
 * inside it (unless a position was chosen). Returns notes for whoever imported it.
 */
export function settleNewRig(project: Project, rig: Rig, opts: { scaled?: boolean; placed?: boolean } = {}): string[] {
  const notes: string[] = []
  const scene = project.rigs.find((r) => r.id === project.activeRigId) ?? project.rigs[0]
  if (!opts.scaled && scene && scene.units === 'studs' && rig.units === 'meters') {
    scaleRig(rig, STUDS_PER_METER)
    rig.units = 'studs'
    notes.push(`Scaled by ${STUDS_PER_METER.toFixed(2)} to convert metres to studs, matching ${scene.name}.`)
  }
  if (!opts.placed && project.rigs.length) {
    let maxX = -Infinity
    for (const r of project.rigs) maxX = Math.max(maxX, rigBounds(r, restWorld(r)).max[0])
    const b = rigBounds(rig, restWorld(rig))
    const gap = Math.max(0.5, (b.max[0] - b.min[0]) * 0.25)
    rig.origin = { p: [rig.origin.p[0] + maxX + gap - b.min[0], rig.origin.p[1], rig.origin.p[2]], q: rig.origin.q }
    notes.push(`Placed beside the existing rigs at x ${rig.origin.p[0].toFixed(2)}.`)
  }
  return notes
}

export function evaluateWorld(clip: Clip, rig: Rig, frame: number): { pose: Pose; world: WorldPose } {
  const pose = evaluateRig(clip, rig, frame)
  return { pose, world: computeWorld(rig, pose) }
}

export function sampleCamera(keys: CameraKey[], frame: number): { position: Vec3; target: Vec3; fov: number } | undefined {
  if (!keys.length) return undefined
  const i = keyIndexAt(keys, frame)
  if (i < 0) return keys[0]
  const a = keys[i]
  if (i === keys.length - 1 || a.frame === frame) return a
  const b = keys[i + 1]
  const t = ease(a.ease, a.dir, (frame - a.frame) / (b.frame - a.frame))
  return { position: vlerp(a.position, b.position, t), target: vlerp(a.target, b.target, t), fov: a.fov + (b.fov - a.fov) * t }
}

// ---------- editing ----------

/** Write keys for every bone present in `pose` at `frame`. New keys inherit easing from the key before them. */
export function writePoseKeys(
  clip: Clip, rig: Rig, frame: number, pose: Pose,
  easing?: { ease: EaseStyle; dir: EaseDir }, bones?: string[]
): string[] {
  const tracks = (clip.tracks[rig.id] ??= {})
  const written: string[] = []
  for (const b of rig.bones) {
    if (b.locked) continue
    if (bones && !bones.includes(b.name)) continue
    const t = pose[b.name]
    if (!t) continue
    const keys = (tracks[b.name] ??= [])
    const prevIdx = keyIndexAt(keys, frame)
    const prev = prevIdx >= 0 ? keys[prevIdx] : undefined
    const existing = prev && prev.frame === frame ? prev : undefined
    const e = easing ?? (existing ? { ease: existing.ease, dir: existing.dir } : prev ? { ease: prev.ease, dir: prev.dir } : { ease: 'linear' as EaseStyle, dir: 'inout' as EaseDir })
    const key: Key = { frame, q: [...t.q] as Quat, ease: e.ease, dir: e.dir }
    if (b.translatable && t.p) key.p = [...t.p] as Vec3
    else if (b.translatable && keys.some((k) => k.p)) key.p = [0, 0, 0]
    upsertKey(keys, key)
    written.push(b.name)
  }
  if (frame > clip.length) clip.length = frame
  return written
}

/** All frames that carry at least one key (bone, IK, or camera), sorted. */
export function keyFrames(clip: Clip, rigId?: string): number[] {
  const s = new Set<number>()
  for (const rid in clip.tracks) {
    if (rigId && rid !== rigId) continue
    for (const b in clip.tracks[rid]) for (const k of clip.tracks[rid][b]) s.add(k.frame)
  }
  for (const rid in clip.ikTracks) {
    if (rigId && rid !== rigId) continue
    for (const c in clip.ikTracks[rid]) for (const k of clip.ikTracks[rid][c]) s.add(k.frame)
  }
  if (!rigId) for (const k of clip.camera) s.add(k.frame)
  return [...s].sort((a, b) => a - b)
}

export function getClip(project: Project, idOrName?: string | null): Clip {
  const key = idOrName ?? project.activeClipId
  const clip = project.clips.find((c) => c.id === key) ?? project.clips.find((c) => c.name === key)
  if (!clip) {
    if (!project.clips.length) throw new Error('There are no clips yet. Call create_clip first.')
    throw new Error(`Unknown clip "${key}". Clips: ${project.clips.map((c) => `${c.name} (${c.id})`).join(', ')}`)
  }
  return clip
}

export function getRig(project: Project, idOrName?: string | null): Rig {
  const key = idOrName ?? project.activeRigId ?? project.rigs[0]?.id
  const rig = project.rigs.find((r) => r.id === key) ?? project.rigs.find((r) => r.name === key)
  if (!rig) throw new Error(`Unknown rig "${key}". Rigs: ${project.rigs.map((r) => `${r.name} (${r.id})`).join(', ') || '(none)'}`)
  return rig
}

/**
 * The rig a first-person view looks through: the named rig, else the active rig when it has a head,
 * else the first rig that has one (so a selected prop or camera rig does not switch first person off).
 */
export function firstPersonRig(project: Project, idOrName?: string | null): Rig | undefined {
  if (idOrName) {
    const r = project.rigs.find((x) => x.id === idOrName) ?? project.rigs.find((x) => x.name === idOrName)
    return r?.head ? r : undefined
  }
  const active = project.rigs.find((r) => r.id === project.activeRigId)
  return active?.head ? active : project.rigs.find((r) => r.head)
}

export { getChain, qid }
