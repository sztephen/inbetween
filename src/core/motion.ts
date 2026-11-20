// Numbers the AI cannot get from still frames: where the weight is, and how the motion is timed.
import { evaluateRig, keyFrames } from './clip'
import { qrot, round, vdist, xpoint, type Vec3 } from './math'
import { computeWorld, effectorWorld, rigHeight, type WorldPose } from './rig'
import type { Clip, Rig } from './types'

type P2 = [number, number]

/** Volume-weighted centre of the rig's boxes, or null when the rig has no shapes to weigh. */
export function centerOfMass(rig: Rig, world: WorldPose): Vec3 | null {
  let m = 0
  const c: Vec3 = [0, 0, 0]
  for (const b of rig.bones) {
    if (!b.shape || b.locked) continue
    const v = Math.abs(b.shape.size[0] * b.shape.size[1] * b.shape.size[2])
    if (!(v > 0)) continue
    const p = xpoint(world.bone[b.name], b.shape.offset ?? [0, 0, 0])
    c[0] += p[0] * v
    c[1] += p[1] * v
    c[2] += p[2] * v
    m += v
  }
  return m > 0 ? [c[0] / m, c[1] / m, c[2] / m] : null
}

/** Ground footprint: the XZ of every box corner resting on (or within `tol` of) the ground. */
function supportPoints(rig: Rig, world: WorldPose, groundY: number, tol: number): P2[] {
  const pts: P2[] = []
  for (const b of rig.bones) {
    if (!b.shape || b.locked) continue
    const h = b.shape.size.map((s) => s / 2) as Vec3
    const o = b.shape.offset ?? [0, 0, 0]
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const p = xpoint(world.bone[b.name], [o[0] + sx * h[0], o[1] + sy * h[1], o[2] + sz * h[2]])
      if (p[1] <= groundY + tol) pts.push([p[0], p[2]])
    }
  }
  return pts
}

function convexHull(points: P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: P2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: P2[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** Nearest point of a convex polygon (or segment, or point) to p; p itself when it lies inside. */
function nearestOnHull(hull: P2[], p: P2): P2 {
  if (hull.length === 1) return hull[0]
  if (hull.length >= 3) {
    let inside = true
    for (let i = 0; i < hull.length && inside; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length]
      if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) inside = false
    }
    if (inside) return p
  }
  let best: P2 = hull[0], bd = Infinity
  const n = hull.length === 2 ? 1 : hull.length
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    const dx = b[0] - a[0], dz = b[1] - a[1]
    const len = dx * dx + dz * dz
    const t = len > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len)) : 0
    const q: P2 = [a[0] + dx * t, a[1] + dz * t]
    const d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (d < bd) {
      bd = d
      best = q
    }
  }
  return best
}

export interface Balance {
  com: Vec3
  /** Something is touching the ground. False = airborne. */
  grounded: boolean
  /** How far the centre of mass is outside the ground footprint (0 when over it). */
  offset: number
  /** Which way it overhangs, in the character's terms, e.g. "forward" or "back and to its left". */
  direction: string
}

/** Static balance of one pose: is the centre of mass over what the character is standing on? */
export function poseBalance(rig: Rig, world: WorldPose, groundY = 0): Balance | null {
  const com = centerOfMass(rig, world)
  if (!com) return null
  const pts = supportPoints(rig, world, groundY, rigHeight(rig) * 0.03)
  if (!pts.length) return { com, grounded: false, offset: 0, direction: '' }
  const p: P2 = [com[0], com[2]]
  const q = nearestOnHull(convexHull(pts), p)
  const dx = p[0] - q[0], dz = p[1] - q[1]
  const offset = Math.hypot(dx, dz)
  // Express the overhang along the character's own forward and right.
  const f = qrot(rig.origin.q, rig.forward ?? [0, 0, -1])
  const fl = Math.hypot(f[0], f[2]) || 1
  const fx = f[0] / fl, fz = f[2] / fl
  const fwd = dx * fx + dz * fz
  const right = dx * -fz + dz * fx
  const parts: string[] = []
  if (Math.abs(fwd) > offset * 0.35) parts.push(fwd > 0 ? 'forward' : 'back')
  if (Math.abs(right) > offset * 0.35) parts.push(right > 0 ? 'to its right' : 'to its left')
  return { com, grounded: true, offset, direction: parts.join(' and ') }
}

/** How far outside the footprint the centre of mass may sit before a held pose counts as falling over. */
export const balanceMargin = (rig: Rig): number => rigHeight(rig) * 0.03

// ---------------------------------------------------------------- timing report

export interface MotionReport {
  clip: string
  rig: string
  fps: number
  length_frames: number
  units: string
  parts: Record<string, {
    travel: number
    peak_speed: number
    peak_frame: number
    /** Frames on which this part comes to rest after moving. */
    stops_at: number[]
    /** Speed in units per second; one value per `speed_step_frames` frames (the fastest within the step). */
    speed: number[]
  }>
  speed_step_frames: number
  /** Stretches where nothing moves at all. */
  holds: [number, number][]
  /** Key-to-key spacing: how long each move takes and how far the busiest part goes in it. */
  segments: { from: number; to: number; frames: number; biggest_mover: string; distance: number; peak_speed: number }[]
  notes: string[]
}

export function motionReport(clip: Clip, rig: Rig, partNames?: string[]): MotionReport {
  const names = partNames?.length ? partNames : [rig.hips, ...(rig.head ? [rig.head] : []), ...rig.chains.map((c) => c.name)]
  const point = (world: WorldPose, name: string): Vec3 => {
    const chain = rig.chains.find((c) => c.name === name)
    if (chain) return effectorWorld(rig, world, chain)
    const b = world.bone[name]
    if (!b) throw new Error(`Unknown part "${name}" on ${rig.name}. Use an IK chain (${rig.chains.map((c) => c.name).join(', ')}) or a bone name.`)
    return b.p
  }
  const frames = clip.length + 1
  const pos: Record<string, Vec3[]> = Object.fromEntries(names.map((n) => [n, []]))
  for (let f = 0; f < frames; f++) {
    const world = computeWorld(rig, evaluateRig(clip, rig, f))
    for (const n of names) pos[n].push(point(world, n))
  }
  const height = rigHeight(rig)
  const still = height * 0.004 // per frame
  const step = Math.max(1, Math.ceil(clip.length / 40))
  const parts: MotionReport['parts'] = {}
  const perFrame: Record<string, number[]> = {}
  for (const n of names) {
    const d: number[] = []
    for (let f = 0; f < frames - 1; f++) d.push(vdist(pos[n][f], pos[n][f + 1]))
    perFrame[n] = d
    let peak = 0, peakFrame = 0, travel = 0
    d.forEach((x, i) => {
      travel += x
      if (x > peak) {
        peak = x
        peakFrame = i + 1
      }
    })
    const stops: number[] = []
    for (let i = 1; i < d.length; i++) if (d[i - 1] > still && d[i] <= still && (i + 1 >= d.length || d[i + 1] <= still)) stops.push(i)
    if (d.length && d[d.length - 1] > still && !clip.loop) stops.push(clip.length)
    const speed: number[] = []
    for (let i = 0; i < d.length; i += step) speed.push(round(Math.max(...d.slice(i, i + step)) * clip.fps, 1))
    parts[n] = { travel: round(travel, 2), peak_speed: round(peak * clip.fps, 1), peak_frame: peakFrame, stops_at: stops, speed }
  }

  const holds: [number, number][] = []
  let start = -1
  for (let f = 0; f < frames - 1; f++) {
    const quiet = names.every((n) => perFrame[n][f] <= still)
    if (quiet && start < 0) start = f
    if ((!quiet || f === frames - 2) && start >= 0) {
      const end = quiet ? f + 1 : f
      if (end - start >= 2) holds.push([start, end])
      start = -1
    }
  }

  const keys = keyFrames(clip, rig.id).filter((f) => f <= clip.length)
  const segments: MotionReport['segments'] = []
  for (let i = 0; i < keys.length - 1 && segments.length < 40; i++) {
    const a = keys[i], b = keys[i + 1]
    let mover = names[0], dist = 0, peak = 0
    for (const n of names) {
      const d = vdist(pos[n][a], pos[n][b])
      if (d > dist) {
        dist = d
        mover = n
      }
      for (let f = a; f < b; f++) peak = Math.max(peak, perFrame[n][f])
    }
    segments.push({ from: a, to: b, frames: b - a, biggest_mover: mover, distance: round(dist, 2), peak_speed: round(peak * clip.fps, 1) })
  }

  const notes: string[] = []
  // Everything landing on one frame reads as robotic; overlap wants the parts to arrive a few frames apart.
  const byFrame = new Map<number, string[]>()
  for (const n of names) for (const f of parts[n].stops_at) byFrame.set(f, [...(byFrame.get(f) ?? []), n])
  for (const [f, who] of [...byFrame].sort((x, y) => x[0] - y[0])) {
    if (who.length >= 3 && who.length >= Math.ceil(names.length * 0.6)) {
      notes.push(`${who.join(', ')} all come to rest on frame ${f}. If this is not a deliberate hit or freeze, let the hips arrive first and the hands and head settle 2 to 4 frames later.`)
    }
  }
  const tracks = clip.tracks[rig.id] ?? {}
  const stepped = new Set<number>()
  for (const b in tracks) tracks[b].forEach((k, i) => i < tracks[b].length - 1 && k.ease === 'constant' && stepped.add(k.frame))
  if (stepped.size) notes.push(`Keys on frame(s) ${[...stepped].sort((x, y) => x - y).join(', ')} still use stepped timing, so the pose pops to the next key instead of moving. Give them real easing with set_timing unless a hard cut is intended.`)
  if (!keys.length) notes.push('This rig has no keys in this clip yet.')
  const moving = names.filter((n) => parts[n].travel > height * 0.02)
  if (keys.length && !moving.length) notes.push('Nothing moves more than a hair in this clip.')

  return { clip: clip.name, rig: rig.name, fps: clip.fps, length_frames: clip.length, units: `${rig.units} per second`, parts, speed_step_frames: step, holds, segments, notes }
}
