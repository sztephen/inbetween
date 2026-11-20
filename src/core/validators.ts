import { contactTarget, evaluateRig, isConstrainedFrame, keyIndexAt, sampleFK } from './clip'
import { limitViolation } from './ik'
import { qangle, qrot, qToMat3, round, vdist, vdot, vlen, vsub, xpoint, type Vec3, type Xform } from './math'
import { computeWorld, effectorWorld, orderedBones, restWorld, rigHeight, type WorldPose } from './rig'
import { balanceMargin, poseBalance } from './motion'
import type { Clip, Rig } from './types'

export type CheckName = 'foot_sliding' | 'joint_limits' | 'self_intersection' | 'jitter' | 'loop_mismatch' | 'ground_penetration' | 'balance'
export const ALL_CHECKS: CheckName[] = ['foot_sliding', 'joint_limits', 'self_intersection', 'jitter', 'loop_mismatch', 'ground_penetration', 'balance']

export interface Problem {
  check: CheckName
  severity: 'error' | 'warning'
  rig: string
  /** First and last frame the problem spans. */
  frames: [number, number]
  /** Bone or chain involved. */
  subject: string
  message: string
  /** Size of the problem in the check's units (studs/meters or degrees). */
  amount: number
}

export interface CheckOptions {
  checks?: CheckName[]
  /** Scene-space ground height. */
  groundY?: number
}

interface Sample {
  frame: number
  world: WorldPose
}

function sampleClip(clip: Clip, rig: Rig): Sample[] {
  const out: Sample[] = []
  for (let f = 0; f <= clip.length; f++) out.push({ frame: f, world: computeWorld(rig, evaluateRig(clip, rig, f)) })
  return out
}

/** Collapse per-frame hits into ranges, keeping the worst amount. */
function ranges<T extends { frame: number; amount: number }>(hits: T[]): { start: number; end: number; worst: T }[] {
  const out: { start: number; end: number; worst: T }[] = []
  for (const h of hits) {
    const last = out[out.length - 1]
    if (last && h.frame <= last.end + 1) {
      last.end = h.frame
      if (Math.abs(h.amount) > Math.abs(last.worst.amount)) last.worst = h
    } else out.push({ start: h.frame, end: h.frame, worst: h })
  }
  return out
}

// ----- foot sliding: effector drifting off its contact target -----
export function checkFootSliding(clip: Clip, rig: Rig, samples: Sample[], tol: number): Problem[] {
  const problems: Problem[] = []
  for (const c of clip.contacts) {
    if (c.rig !== rig.id) continue
    const chain = rig.chains.find((x) => x.name === c.chain)
    if (!chain) continue
    const hits: { frame: number; amount: number }[] = []
    for (const s of samples) {
      if (s.frame < c.start || s.frame > c.end) continue
      const d = vdist(effectorWorld(rig, s.world, chain), contactTarget(c, s.frame))
      if (d > tol) hits.push({ frame: s.frame, amount: d })
    }
    for (const r of ranges(hits)) {
      problems.push({
        check: 'foot_sliding', severity: 'error', rig: rig.id, frames: [r.start, r.end], subject: c.chain,
        amount: round(r.worst.amount),
        message: `${c.chain} drifts up to ${r.worst.amount.toFixed(2)} ${rig.units} off its contact (worst at frame ${r.worst.frame}). The limb cannot reach the planted point: move the hips closer/lower, shorten the contact range, or move the contact.`
      })
    }
  }
  return problems
}

// ----- joint limits -----
export function checkJointLimits(clip: Clip, rig: Rig, tolDeg = 0.5): Problem[] {
  const problems: Problem[] = []
  const perBone: Record<string, { frame: number; amount: number; axis: string; range: string }[]> = {}
  for (let f = 0; f <= clip.length; f++) {
    // Constrained frames are solved with limits enforced; check what will actually play.
    const pose = isConstrainedFrame(clip, rig.id, f) ? evaluateRig(clip, rig, f) : sampleFK(clip, rig, f)
    for (const b of rig.bones) {
      if ((!b.limits && !b.cone) || !pose[b.name]) continue
      const v = limitViolation(b, pose[b.name].q, tolDeg)
      if (v) (perBone[b.name] ??= []).push({ frame: f, ...v })
    }
  }
  for (const bone in perBone) {
    for (const r of ranges(perBone[bone])) {
      problems.push({
        check: 'joint_limits', severity: 'error', rig: rig.id, frames: [r.start, r.end], subject: bone,
        amount: round(r.worst.amount, 1),
        message: `${bone} exceeds its ${r.worst.axis} limit (${r.worst.range}) by ${r.worst.amount.toFixed(1)} deg (worst at frame ${r.worst.frame}).`
      })
    }
  }
  return problems
}

// ----- self intersection: oriented boxes of non-neighbouring parts -----
interface OBB {
  c: Vec3
  axes: [Vec3, Vec3, Vec3]
  h: Vec3
}
function obbOf(x: Xform, size: Vec3, offset: Vec3 | undefined, shrink: number): OBB {
  const m = qToMat3(x.q)
  return {
    c: offset ? xpoint(x, offset) : x.p,
    axes: [[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]],
    h: [(size[0] / 2) * shrink, (size[1] / 2) * shrink, (size[2] / 2) * shrink]
  }
}
/** Penetration depth of two oriented boxes (0 if separated), by the separating axis test. */
export function obbPenetration(a: OBB, b: OBB): number {
  const d = vsub(b.c, a.c)
  let min = Infinity
  const test = (axis: Vec3): boolean => {
    const l = vlen(axis)
    if (l < 1e-6) return true
    const n: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l]
    const ra = a.h[0] * Math.abs(vdot(a.axes[0], n)) + a.h[1] * Math.abs(vdot(a.axes[1], n)) + a.h[2] * Math.abs(vdot(a.axes[2], n))
    const rb = b.h[0] * Math.abs(vdot(b.axes[0], n)) + b.h[1] * Math.abs(vdot(b.axes[1], n)) + b.h[2] * Math.abs(vdot(b.axes[2], n))
    const overlap = ra + rb - Math.abs(vdot(d, n))
    if (overlap <= 0) return false
    if (overlap < min) min = overlap
    return true
  }
  for (let i = 0; i < 3; i++) if (!test(a.axes[i])) return 0
  for (let i = 0; i < 3; i++) if (!test(b.axes[i])) return 0
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const ax: Vec3 = [
      a.axes[i][1] * b.axes[j][2] - a.axes[i][2] * b.axes[j][1],
      a.axes[i][2] * b.axes[j][0] - a.axes[i][0] * b.axes[j][2],
      a.axes[i][0] * b.axes[j][1] - a.axes[i][1] * b.axes[j][0]
    ]
    if (!test(ax)) return 0
  }
  return min === Infinity ? 0 : min
}

const pairCache = new WeakMap<Rig, [string, string][]>()
/** Part pairs worth testing: not parent/child, not siblings, not already touching at rest. */
function collisionPairs(rig: Rig): [string, string][] {
  let pairs = pairCache.get(rig)
  if (pairs) return pairs
  pairs = []
  const shaped = rig.bones.filter((b) => b.shape && !b.locked)
  const rest = restWorld(rig)
  for (let i = 0; i < shaped.length; i++) for (let j = i + 1; j < shaped.length; j++) {
    const a = shaped[i], b = shaped[j]
    if (a.parent === b.name || b.parent === a.name) continue
    if (a.parent && a.parent === b.parent) continue
    const pen = obbPenetration(
      obbOf(rest.bone[a.name], a.shape!.size, a.shape!.offset, 0.85),
      obbOf(rest.bone[b.name], b.shape!.size, b.shape!.offset, 0.85)
    )
    if (pen > 0) continue
    pairs.push([a.name, b.name])
  }
  pairCache.set(rig, pairs)
  return pairs
}

export function checkSelfIntersection(rig: Rig, samples: Sample[], minDepth: number): Problem[] {
  const problems: Problem[] = []
  const bones = new Map(rig.bones.map((b) => [b.name, b]))
  for (const [an, bn] of collisionPairs(rig)) {
    const a = bones.get(an)!, b = bones.get(bn)!
    const hits: { frame: number; amount: number }[] = []
    for (const s of samples) {
      const pen = obbPenetration(
        obbOf(s.world.bone[an], a.shape!.size, a.shape!.offset, 0.85),
        obbOf(s.world.bone[bn], b.shape!.size, b.shape!.offset, 0.85)
      )
      if (pen > minDepth) hits.push({ frame: s.frame, amount: pen })
    }
    for (const r of ranges(hits)) {
      problems.push({
        check: 'self_intersection', severity: 'warning', rig: rig.id, frames: [r.start, r.end], subject: `${an}/${bn}`,
        amount: round(r.worst.amount),
        message: `${an} passes through ${bn} by ${r.worst.amount.toFixed(2)} ${rig.units} (worst at frame ${r.worst.frame}).`
      })
    }
  }
  return problems
}

// ----- jitter / velocity spikes -----
export function checkJitter(clip: Clip, rig: Rig, samples: Sample[], height: number): Problem[] {
  const problems: Problem[] = []
  if (samples.length < 4) return problems
  const eps = height * 0.004
  const popSpeed = height * 0.45
  // Frames inside a stepped (constant) segment hold and then jump by design; skip those transitions.
  const stepped = (bone: string, f: number): boolean => {
    const keys = clip.tracks[rig.id]?.[bone]
    if (!keys?.length) return false
    const i = keyIndexAt(keys, f)
    return i >= 0 && i < keys.length - 1 && keys[i].ease === 'constant'
  }
  const anySteppedAncestor = (bone: string, f: number): boolean => {
    let b = rig.bones.find((x) => x.name === bone)
    while (b) {
      if (stepped(b.name, f)) return true
      b = b.parent ? rig.bones.find((x) => x.name === b!.parent) : undefined
    }
    return false
  }
  for (const b of orderedBones(rig)) {
    if (b.locked) continue
    const pos = samples.map((s) => s.world.bone[b.name].p)
    const vel: Vec3[] = []
    for (let i = 0; i < pos.length - 1; i++) vel.push(vsub(pos[i + 1], pos[i]))
    const hits: { frame: number; amount: number; kind: string }[] = []
    for (let i = 0; i < vel.length; i++) {
      const f = samples[i].frame
      if (anySteppedAncestor(b.name, f)) continue
      const sp = vlen(vel[i])
      if (sp > popSpeed) {
        hits.push({ frame: f + 1, amount: sp, kind: 'pop' })
        continue
      }
      // Jitter: direction flips on consecutive frames (back-forth-back).
      if (i >= 1 && i < vel.length - 1) {
        const a = vel[i - 1], c = vel[i + 1]
        if (vlen(a) > eps && sp > eps && vlen(c) > eps && vdot(a, vel[i]) < 0 && vdot(vel[i], c) < 0) {
          if (!anySteppedAncestor(b.name, f - 1) && !anySteppedAncestor(b.name, f + 1)) hits.push({ frame: f, amount: sp, kind: 'jitter' })
        }
      }
    }
    for (const r of ranges(hits)) {
      const pop = r.worst.kind === 'pop'
      problems.push({
        check: 'jitter', severity: 'warning', rig: rig.id, frames: [r.start, r.end], subject: b.name,
        amount: round(r.worst.amount),
        message: pop
          ? `${b.name} jumps ${r.worst.amount.toFixed(2)} ${rig.units} in one frame at frame ${r.worst.frame} (velocity spike). Add an in-between or spread the move over more frames; use stepped timing if a hard cut is intended.`
          : `${b.name} jitters (reverses direction every frame) around frame ${r.worst.frame}. Remove or retime the conflicting keys.`
      })
    }
  }
  // Report only the most-parent bone per frame range to avoid a cascade of duplicates down the chain.
  const seen: Problem[] = []
  for (const p of problems) {
    const bone = rig.bones.find((x) => x.name === p.subject)
    let anc = bone?.parent
    let dup = false
    while (anc && !dup) {
      dup = seen.some((s) => s.subject === anc && s.frames[0] <= p.frames[1] && s.frames[1] >= p.frames[0])
      anc = rig.bones.find((x) => x.name === anc)?.parent ?? undefined
    }
    if (!dup) seen.push(p)
  }
  return seen
}

// ----- loop continuity -----
export function checkLoop(clip: Clip, rig: Rig, height: number): Problem[] {
  if (!clip.loop || clip.length < 1) return []
  const a = evaluateRig(clip, rig, 0), b = evaluateRig(clip, rig, clip.length)
  const problems: Problem[] = []
  for (const bone of rig.bones) {
    const qa = a[bone.name]?.q ?? [0, 0, 0, 1], qb = b[bone.name]?.q ?? [0, 0, 0, 1]
    const ang = (qangle(qa, qb) * 180) / Math.PI
    const dp = vdist(a[bone.name]?.p ?? [0, 0, 0], b[bone.name]?.p ?? [0, 0, 0])
    if (ang > 1 || dp > height * 0.004) {
      problems.push({
        check: 'loop_mismatch', severity: 'error', rig: rig.id, frames: [0, clip.length], subject: bone.name,
        amount: round(Math.max(ang, dp), 2),
        message: `Loop seam: ${bone.name} differs between frame 0 and frame ${clip.length} by ${ang > 1 ? ang.toFixed(1) + ' deg' : dp.toFixed(2) + ' ' + rig.units}. Copy the frame 0 pose to frame ${clip.length} (copy_pose_to_frame).`
      })
    }
  }
  return problems
}

// ----- feet (any part) under the ground -----
export function checkGround(rig: Rig, samples: Sample[], groundY: number, tol: number): Problem[] {
  const problems: Problem[] = []
  for (const b of rig.bones) {
    if (!b.shape || b.locked) continue
    const h: Vec3 = [b.shape.size[0] / 2, b.shape.size[1] / 2, b.shape.size[2] / 2]
    const o = b.shape.offset ?? [0, 0, 0]
    const hits: { frame: number; amount: number }[] = []
    for (const s of samples) {
      const w = s.world.bone[b.name]
      let low = Infinity
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const y = w.p[1] + qrot(w.q, [o[0] + sx * h[0], o[1] + sy * h[1], o[2] + sz * h[2]])[1]
        if (y < low) low = y
      }
      if (low < groundY - tol) hits.push({ frame: s.frame, amount: groundY - low })
    }
    for (const r of ranges(hits)) {
      problems.push({
        check: 'ground_penetration', severity: 'error', rig: rig.id, frames: [r.start, r.end], subject: b.name,
        amount: round(r.worst.amount),
        message: `${b.name} sinks ${r.worst.amount.toFixed(2)} ${rig.units} below the ground (worst at frame ${r.worst.frame}). Raise the foot goal or the hips, or level the foot.`
      })
    }
  }
  return problems
}

// ----- balance: a held pose whose weight is not over its support -----
export function checkBalance(clip: Clip, rig: Rig, samples: Sample[], height: number, groundY: number): Problem[] {
  const margin = balanceMargin(rig)
  const still = height * 0.004
  const hits: { frame: number; amount: number; direction: string }[] = []
  samples.forEach((s, i) => {
    // Only poses the character holds: momentum carries it through anything it is moving through.
    const prev = samples[i - 1], next = samples[i + 1]
    const hips = (x: Sample): Vec3 => x.world.bone[rig.hips].p
    if ((prev && vdist(hips(prev), hips(s)) > still) || (next && vdist(hips(next), hips(s)) > still)) return
    // A planted hand (leaning on a wall, hanging from a ledge) is support this check cannot weigh.
    if (clip.contacts.some((c) => c.rig === rig.id && s.frame >= c.start && s.frame <= c.end && rig.chains.find((x) => x.name === c.chain)?.kind !== 'leg')) return
    const b = poseBalance(rig, s.world, groundY)
    if (b && b.grounded && b.offset > margin) hits.push({ frame: s.frame, amount: b.offset, direction: b.direction })
  })
  const problems: Problem[] = []
  for (const r of ranges(hits)) {
    if (r.end - r.start < 3) continue
    problems.push({
      check: 'balance', severity: 'warning', rig: rig.id, frames: [r.start, r.end], subject: rig.hips,
      amount: round(r.worst.amount),
      message: `Held off balance: the centre of mass sits ${r.worst.amount.toFixed(2)} ${rig.units} ${r.worst.direction || 'outside'} of what the character is standing on (worst at frame ${r.worst.frame}), so it would tip over. Bring the hips back over the supporting foot, or step a foot under the weight.`
    })
  }
  return problems
}

/** The checks that make sense for a single pose, for immediate feedback while posing. */
export function checkPose(clip: Clip, rig: Rig, frame: number, groundY = 0): string[] {
  const height = rigHeight(rig)
  const sample: Sample = { frame, world: computeWorld(rig, evaluateRig(clip, rig, frame)) }
  const out = [...checkSelfIntersection(rig, [sample], height * 0.03)]
  if (rig.source !== 'prop') out.push(...checkGround(rig, [sample], groundY, height * 0.012))
  const notes = out.map((p) => p.message.replace(/ \(worst at frame \d+\)/, ''))
  if (rig.source !== 'prop') {
    const b = poseBalance(rig, sample.world, groundY)
    if (b && b.grounded && b.offset > balanceMargin(rig)) {
      notes.push(`Weight: the centre of mass is ${b.offset.toFixed(2)} ${rig.units} ${b.direction || 'outside'} of the feet. Fine for a pose the character moves through; if it is held, it tips over.`)
    }
  }
  return notes
}

export function checkClip(clip: Clip, rig: Rig, opts: CheckOptions = {}): Problem[] {
  const checks = opts.checks ?? ALL_CHECKS
  const height = rigHeight(rig)
  const samples = sampleClip(clip, rig)
  const out: Problem[] = []
  if (checks.includes('foot_sliding')) out.push(...checkFootSliding(clip, rig, samples, height * 0.012))
  if (checks.includes('joint_limits')) out.push(...checkJointLimits(clip, rig))
  if (checks.includes('self_intersection')) out.push(...checkSelfIntersection(rig, samples, height * 0.03))
  if (checks.includes('jitter')) out.push(...checkJitter(clip, rig, samples, height))
  if (checks.includes('loop_mismatch')) out.push(...checkLoop(clip, rig, height))
  if (checks.includes('ground_penetration') && rig.source !== 'prop') out.push(...checkGround(rig, samples, opts.groundY ?? 0, height * 0.012))
  if (checks.includes('balance') && rig.source !== 'prop') out.push(...checkBalance(clip, rig, samples, height, opts.groundY ?? 0))
  return out.sort((a, b) => a.frames[0] - b.frames[0])
}
