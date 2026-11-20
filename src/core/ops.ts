// Document operations shared by the AI tools and the manual UI. Each takes a project draft
// (inside ProjectStore.mutate) and edits it in place.
import { contactTarget, evaluateRig, getClip, getRig, keyFrames, keyIndexAt, newId, removeKeyAt, sampleFK, upsertKey, writePoseKeys } from './clip'
import { TIMING_PRESETS } from './easing'
import { restBoneRot, solveChain } from './ik'
import { qmul, qnorm, vsub, type Quat, type Vec3 } from './math'
import { applyGoals, mirrorPose, type GoalReport, type GoalSpec } from './pose'
import { clonePose, computeWorld, effectorWorld, getBone, getChain } from './rig'
import type { CameraKey, Clip, Contact, EaseDir, EaseStyle, IKKey, Key, Pose, Project, Rig } from './types'

export type Easing = { ease: EaseStyle; dir: EaseDir }

export function resolveEasing(t?: string | Partial<Easing> | null): Easing | undefined {
  if (t == null) return undefined
  if (typeof t === 'string') {
    const p = TIMING_PRESETS[t]
    if (!p) throw new Error(`Unknown timing preset "${t}". Presets: ${Object.keys(TIMING_PRESETS).join(', ')}`)
    return { ease: p.ease, dir: p.dir }
  }
  if (!t.ease) return undefined
  return { ease: t.ease, dir: t.dir ?? 'inout' }
}

function checkFrame(clip: Clip, frame: number): void {
  if (!Number.isInteger(frame) || frame < 0) throw new Error(`Frame must be a whole number >= 0 (got ${frame}).`)
  if (frame > 100000) throw new Error('Frame is unreasonably large.')
  void clip
}

export interface SetPoseArgs {
  clip: Clip
  rig: Rig
  frame: number
  spec: GoalSpec
  /** Start from the pose at this frame ('current'), the rest pose, or a saved pose. */
  base?: Pose
  easing?: Easing
  /** Chains whose goals should also be written as IK-target keys (straight effector paths between such keys). */
  straight?: string[]
  /** Only key bones that this call changed. */
  onlyChanged?: boolean
}

export interface SetPoseResult extends GoalReport {
  written: string[]
  effectors: Record<string, Vec3>
}

export function opSetPose(a: SetPoseArgs): SetPoseResult {
  const { clip, rig, frame } = a
  checkFrame(clip, frame)
  const start = a.base ? clonePose(a.base) : evaluateRig(clip, rig, frame)
  const pose = clonePose(start)
  const report = applyGoals(rig, pose, a.spec)

  let bones: string[] | undefined
  if (a.onlyChanged) {
    bones = rig.bones.filter((b) => {
      const x = start[b.name], y = pose[b.name]
      if (!y) return false
      if (!x) return true
      return Math.abs(x.q[0] * y.q[0] + x.q[1] * y.q[1] + x.q[2] * y.q[2] + x.q[3] * y.q[3]) < 0.9999999 ||
        JSON.stringify(x.p ?? null) !== JSON.stringify(y.p ?? null)
    }).map((b) => b.name)
  } else {
    // Key every animatable bone so the frame is a complete, self-contained pose.
    for (const b of rig.bones) if (!b.locked && !pose[b.name]) pose[b.name] = { q: [0, 0, 0, 1] }
  }
  const written = writePoseKeys(clip, rig, frame, pose, a.easing, bones)

  for (const chainName of a.straight ?? []) {
    const g = a.spec.goals?.[chainName]
    if (!g) throw new Error(`straight_paths lists "${chainName}" but there is no goal for it in this call.`)
    const chain = getChain(rig, chainName)
    const world = computeWorld(rig, pose)
    const key: IKKey = {
      frame, position: [...g.position] as Vec3,
      rotation: world.bone[chain.bones[2]].q,
      pole: g.pole ? vsub(g.pole, world.joint[chain.bones[0]].p) : undefined,
      ease: a.easing?.ease ?? 'linear', dir: a.easing?.dir ?? 'inout'
    }
    upsertKey(((clip.ikTracks[rig.id] ??= {})[chainName] ??= []), key)
  }

  const world = computeWorld(rig, evaluateRig(clip, rig, frame))
  const effectors: Record<string, Vec3> = {}
  for (const c of rig.chains) effectors[c.name] = effectorWorld(rig, world, c)
  return { ...report, written, effectors }
}

/** Write an explicit local pose at a frame (manual gizmo edits, load_pose, copy). */
export function opWritePose(clip: Clip, rig: Rig, frame: number, pose: Pose, easing?: Easing, bones?: string[]): string[] {
  checkFrame(clip, frame)
  return writePoseKeys(clip, rig, frame, pose, easing, bones)
}

function eachKeyTrack(clip: Clip, rigId: string | null, bones: string[] | undefined, fn: (keys: { frame: number }[], kind: 'bone' | 'ik' | 'camera', name: string) => void): void {
  for (const rid in clip.tracks) {
    if (rigId && rid !== rigId) continue
    for (const b in clip.tracks[rid]) if (!bones || bones.includes(b)) fn(clip.tracks[rid][b], 'bone', b)
  }
  for (const rid in clip.ikTracks) {
    if (rigId && rid !== rigId) continue
    for (const c in clip.ikTracks[rid]) if (!bones || bones.includes(c)) fn(clip.ikTracks[rid][c], 'ik', c)
  }
  if (!rigId && !bones) fn(clip.camera, 'camera', 'camera')
}

/** Move (or copy) all keys on the given frames. Moves happen simultaneously; keys landing on an occupied frame replace it. */
export function opMoveKeys(clip: Clip, rigId: string | null, moves: { from: number; to: number }[], bones?: string[], copy = false): number {
  for (const m of moves) {
    checkFrame(clip, m.to)
    checkFrame(clip, m.from)
  }
  let count = 0
  eachKeyTrack(clip, rigId, bones, (keys) => {
    const picked: { frame: number }[] = []
    for (const m of moves) {
      const k = keys.find((x) => x.frame === m.from)
      if (k) picked.push({ ...structuredClone(k), frame: m.to })
    }
    if (!picked.length) return
    if (!copy) for (const m of moves) removeKeyAt(keys, m.from)
    for (const k of picked) upsertKey(keys, k)
    count += picked.length
  })
  const maxTo = Math.max(...moves.map((m) => m.to))
  if (maxTo > clip.length) clip.length = maxTo
  return count
}

export function opDeleteKeys(clip: Clip, rigId: string | null, frames: number[], bones?: string[]): number {
  let count = 0
  eachKeyTrack(clip, rigId, bones, (keys) => {
    for (const f of frames) if (removeKeyAt(keys, f)) count++
  })
  // Drop empty tracks so the file stays tidy.
  for (const rid in clip.tracks) for (const b in clip.tracks[rid]) if (!clip.tracks[rid][b].length) delete clip.tracks[rid][b]
  for (const rid in clip.ikTracks) for (const c in clip.ikTracks[rid]) if (!clip.ikTracks[rid][c].length) delete clip.ikTracks[rid][c]
  return count
}

/** Set the easing that leads out of keys on the given frames (or every key). */
export function opSetEasing(clip: Clip, rigId: string | null, frames: number[] | 'all', easing: Easing, bones?: string[]): number {
  let count = 0
  eachKeyTrack(clip, rigId, bones, (keys) => {
    for (const k of keys as (Key | IKKey | CameraKey)[]) {
      if (frames === 'all' || frames.includes(k.frame)) {
        k.ease = easing.ease
        k.dir = easing.dir
        count++
      }
    }
  })
  return count
}

/** Hold the pose at `frame` for `duration` frames: duplicate its keys at frame+duration, optionally pushing later keys back. */
export function opHold(clip: Clip, rigId: string | null, frame: number, duration: number, ripple: boolean): number {
  if (duration < 1) throw new Error('Hold duration must be at least 1 frame.')
  if (ripple) {
    const later = new Set<number>()
    eachKeyTrack(clip, rigId, undefined, (keys) => keys.forEach((k) => k.frame > frame && later.add(k.frame)))
    const moves = [...later].map((f) => ({ from: f, to: f + duration }))
    if (moves.length) opMoveKeys(clip, rigId, moves)
    for (const c of clip.contacts) {
      if (rigId && c.rig !== rigId) continue
      if (c.start > frame) c.start += duration
      if (c.end > frame) c.end += duration
    }
    for (const a of clip.attachments ?? []) {
      if (a.start > frame) a.start += duration
      if (a.end > frame) a.end += duration
    }
    for (const m of clip.markers) if (m.frame > frame) m.frame += duration
    clip.length += duration
  }
  return opMoveKeys(clip, rigId, [{ from: frame, to: frame + duration }], undefined, true)
}

export function opCopyPose(clip: Clip, rig: Rig, from: number, to: number, opts: { mirror?: boolean; bones?: string[]; easing?: Easing } = {}): string[] {
  let pose = evaluateRig(clip, rig, from)
  for (const b of rig.bones) if (!b.locked && !pose[b.name]) pose[b.name] = { q: [0, 0, 0, 1] }
  if (opts.mirror) pose = mirrorPose(rig, pose)
  return opWritePose(clip, rig, to, pose, opts.easing, opts.bones)
}

export function opAddContact(
  clip: Clip, rig: Rig, chainName: string, start: number, end: number,
  opts: { position?: Vec3; slide?: Vec3; rotation?: Vec3 } = {}
): Contact {
  if (end < start) throw new Error(`Contact end (${end}) is before start (${start}).`)
  checkFrame(clip, start)
  checkFrame(clip, end)
  const chain = getChain(rig, chainName)
  const overlap = clip.contacts.find((c) => c.rig === rig.id && c.chain === chainName && c.start <= end && c.end >= start)
  if (overlap) throw new Error(`${chainName} already has a contact over frames ${overlap.start}-${overlap.end} (id ${overlap.id}). Remove it first or choose a non-overlapping range.`)
  const pose = evaluateRig(clip, rig, start)
  const world = computeWorld(rig, pose)
  const position = opts.position ?? effectorWorld(rig, world, chain)
  let rotation: Quat
  if (opts.rotation) {
    const e = opts.rotation.map((d) => (d * Math.PI) / 180)
    const c1 = Math.cos(e[0] / 2), c2 = Math.cos(e[1] / 2), c3 = Math.cos(e[2] / 2)
    const s1 = Math.sin(e[0] / 2), s2 = Math.sin(e[1] / 2), s3 = Math.sin(e[2] / 2)
    const q: Quat = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]
    rotation = qnorm(qmul(rig.origin.q, qmul(q, restBoneRot(rig, chain.bones[2]))))
  } else if (chain.levelEnd) {
    rotation = qnorm(qmul(rig.origin.q, restBoneRot(rig, chain.bones[2])))
  } else {
    rotation = world.bone[chain.bones[2]].q
  }
  const contact: Contact = { id: newId('contact'), rig: rig.id, chain: chainName, start, end, position: [...position] as Vec3, rotation }
  if (opts.slide) contact.slide = [...opts.slide] as Vec3
  clip.contacts.push(contact)
  clip.contacts.sort((a, b) => a.start - b.start)
  if (end > clip.length) clip.length = end
  return contact
}

/** Largest distance between a contact's target and where the limb actually ends up, over its range. */
export function contactError(clip: Clip, rig: Rig, c: Contact): { worst: number; frame: number } {
  const chain = getChain(rig, c.chain)
  let worst = 0, frame = c.start
  for (let f = c.start; f <= c.end; f++) {
    const w = computeWorld(rig, evaluateRig(clip, rig, f))
    const e = effectorWorld(rig, w, chain), t = contactTarget(c, f)
    const d = Math.hypot(e[0] - t[0], e[1] - t[1], e[2] - t[2])
    if (d > worst) {
      worst = d
      frame = f
    }
  }
  return { worst, frame }
}

/** IK handle drag from the UI: solve one chain to a scene-space point and key its bones. */
export function opDragIK(clip: Clip, rig: Rig, frame: number, chainName: string, position: Vec3): { reached: boolean } {
  const pose = evaluateRig(clip, rig, frame)
  const chain = getChain(rig, chainName)
  const res = solveChain(rig, pose, chain, { position })
  opWritePose(clip, rig, frame, pose, undefined, [...chain.bones])
  return { reached: res.reached }
}

export function opSetBone(clip: Clip, rig: Rig, frame: number, bone: string, q: Quat, p?: Vec3): void {
  const b = getBone(rig, bone)
  if (b.locked) throw new Error(`${bone} is locked.`)
  const pose = sampleFK(clip, rig, frame)
  pose[bone] = { q: qnorm(q), p: b.translatable ? (p ?? pose[bone]?.p) : undefined }
  opWritePose(clip, rig, frame, pose, undefined, [bone])
}

export function opSetCamera(clip: Clip, key: CameraKey): void {
  checkFrame(clip, key.frame)
  upsertKey(clip.camera, key)
  if (key.frame > clip.length) clip.length = key.frame
}

/** Compact description of where keys are, for get_clip and the timeline. */
export function summarizeKeys(clip: Clip, rig: Rig): { frames: number[]; bones: Record<string, number[]>; allBonesFrames: number[] } {
  const tracks = clip.tracks[rig.id] ?? {}
  const animatable = rig.bones.filter((b) => !b.locked).map((b) => b.name)
  const frames = keyFrames(clip, rig.id)
  const allBonesFrames = frames.filter((f) => animatable.every((b) => (tracks[b] ?? []).some((k) => k.frame === f)))
  const bones: Record<string, number[]> = {}
  for (const b of animatable) {
    const extra = (tracks[b] ?? []).map((k) => k.frame).filter((f) => !allBonesFrames.includes(f))
    if (extra.length) bones[b] = extra
  }
  return { frames, bones, allBonesFrames }
}

export function easingAt(clip: Clip, rig: Rig, frame: number): Easing | undefined {
  const tracks = clip.tracks[rig.id] ?? {}
  const counts = new Map<string, number>()
  for (const b in tracks) {
    const i = keyIndexAt(tracks[b], frame)
    if (i >= 0 && tracks[b][i].frame === frame) {
      const k = `${tracks[b][i].ease}|${tracks[b][i].dir}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  let best: string | undefined, n = 0
  for (const [k, c] of counts) if (c > n) {
    best = k
    n = c
  }
  if (!best) return undefined
  const [ease, dir] = best.split('|')
  return { ease: ease as EaseStyle, dir: dir as EaseDir }
}

export function presetName(e: Easing): string {
  if (e.ease === 'linear') return 'linear'
  if (e.ease === 'constant') return 'stepped'
  for (const name in TIMING_PRESETS) if (TIMING_PRESETS[name].ease === e.ease && TIMING_PRESETS[name].dir === e.dir) return name
  return `${e.ease}-${e.dir}`
}

export { getClip, getRig }
export type { Project }
