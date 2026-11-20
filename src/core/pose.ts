import { clampToLimits, lookAt, restBoneRot, restJoint, solveChain, type IKResult } from './ik'
import { qFromEulerDeg, qinv, qmul, qnorm, qrot, vsub, xmul, type Quat, type Vec3 } from './math'
import { boneMap, clonePose, computeWorld, effectorWorld, getBone, getChain, mirrorName, mirrorQuat, mirrorVec, parentWorld } from './rig'
import type { Pose, Rig } from './types'

export interface GoalSpec {
  /** Offset of the hips from their rest position (rig units) and/or hips rotation (Euler XYZ degrees). */
  hips?: { position?: Vec3; rotation?: Vec3 }
  /** Direct local rotations (Euler XYZ degrees) and optional positions per bone. */
  bones?: Record<string, { rotation?: Vec3; position?: Vec3 }>
  /** IK goals per chain. position is scene space; rotation is Euler XYZ degrees relative to the end bone's rest orientation; pole is a scene-space point the elbow/knee aims at. */
  goals?: Record<string, { position: Vec3; rotation?: Vec3; pole?: Vec3 }>
  /** Scene-space point for the head to look at. */
  lookAt?: Vec3
  /** Keep un-goaled feet where they were when the hips/spine move. Default true. */
  keepFeet?: boolean
}

export interface GoalReport {
  ik: IKResult[]
  clampedBones: string[]
  keptFeet: string[]
  notes: string[]
}

/** World orientation for an end bone from an Euler offset relative to its rest orientation. */
export function goalRotation(rig: Rig, boneName: string, eulerDeg: Vec3): Quat {
  return qnorm(qmul(rig.origin.q, qmul(qFromEulerDeg(eulerDeg), restBoneRot(rig, boneName))))
}

/**
 * Apply animator-level goals to a pose (mutates and returns it). Order: hips and direct bone
 * rotations, then IK goals, then planted feet, then look-at.
 */
export function applyGoals(rig: Rig, pose: Pose, spec: GoalSpec): GoalReport {
  const report: GoalReport = { ik: [], clampedBones: [], keptFeet: [], notes: [] }
  const before = computeWorld(rig, pose)
  const directlySet = new Set<string>()

  if (spec.hips) {
    const hb = getBone(rig, rig.hips)
    const cur = pose[rig.hips] ?? { q: [0, 0, 0, 1] as Quat }
    const next = { q: cur.q, p: cur.p }
    if (spec.hips.rotation) next.q = qFromEulerDeg(spec.hips.rotation)
    if (spec.hips.position) {
      if (!hb.translatable) report.notes.push(`${rig.hips} cannot translate on this rig; hips.position ignored`)
      else next.p = [...spec.hips.position] as Vec3
    }
    pose[rig.hips] = next
  }

  for (const name in spec.bones ?? {}) {
    const b = getBone(rig, name)
    if (b.locked) throw new Error(`Bone "${name}" is locked and cannot be animated.`)
    const s = spec.bones![name]
    const cur = pose[name] ?? { q: [0, 0, 0, 1] as Quat }
    const next = { q: cur.q, p: cur.p }
    if (s.rotation) {
      const c = clampToLimits(b, qFromEulerDeg(s.rotation))
      if (c.clamped) report.clampedBones.push(name)
      next.q = c.q
    }
    if (s.position) {
      if (!b.translatable) report.notes.push(`${name} cannot translate; position ignored`)
      else next.p = [...s.position] as Vec3
    }
    pose[name] = next
    directlySet.add(name)
  }

  const goals = spec.goals ?? {}
  for (const chainName in goals) {
    const chain = getChain(rig, chainName)
    const g = goals[chainName]
    const rootJoint = xmul(parentWorld(rig, pose, chain.bones[0]), getBone(rig, chain.bones[0]).pre).p
    const res = solveChain(rig, pose, chain, {
      position: g.position,
      rotation: g.rotation ? goalRotation(rig, chain.bones[2], g.rotation) : undefined,
      pole: g.pole ? vsub(g.pole, rootJoint) : undefined
    })
    report.ik.push(res)
  }

  if (spec.keepFeet !== false) {
    for (const chain of rig.chains) {
      if (chain.kind !== 'leg' || goals[chain.name]) continue
      if (chain.bones.some((b) => directlySet.has(b))) continue
      const was = effectorWorld(rig, before, chain)
      const now = effectorWorld(rig, computeWorld(rig, pose), chain)
      if (Math.hypot(was[0] - now[0], was[1] - now[1], was[2] - now[2]) < 1e-4) continue
      const res = solveChain(rig, pose, chain, { position: was, rotation: before.bone[chain.bones[2]].q })
      report.keptFeet.push(chain.name)
      if (!res.reached) report.ik.push({ ...res, note: `kept-in-place foot could not stay planted: ${res.note ?? 'out of reach'}` })
    }
  }

  if (spec.lookAt && rig.head) {
    const r = lookAt(rig, pose, rig.head, spec.lookAt)
    if (r.clamped) report.notes.push('look_at was limited by the neck joint limits')
  }
  return report
}

/** Mirror a pose left<->right across the rig's centre plane. Works for any rest orientation. */
export function mirrorPose(rig: Rig, pose: Pose): Pose {
  const out: Pose = {}
  const bones = boneMap(rig)
  for (const name in pose) {
    const partner = mirrorName(name)
    const target = bones.has(partner) ? partner : name
    if (!bones.has(name)) continue
    const J = restJoint(rig, name).q
    const Jm = restJoint(rig, target).q
    const t = pose[name]
    // Rotation as a rig-space delta, mirrored across X, re-expressed in the partner's joint frame.
    const D = qmul(qmul(J, t.q), qinv(J))
    const q = qnorm(qmul(qmul(qinv(Jm), mirrorQuat(D)), Jm))
    const entry: Pose[string] = { q }
    if (t.p) entry.p = qrot(qinv(Jm), mirrorVec(qrot(J, t.p)))
    out[target] = entry
  }
  return out
}

/** Blend whole poses (used for breakdown helpers). */
export function mergePose(base: Pose, over: Pose, bones?: string[]): Pose {
  const out = clonePose(base)
  for (const k in over) if (!bones || bones.includes(k)) out[k] = { q: [...over[k].q] as Quat, ...(over[k].p ? { p: [...over[k].p!] as Vec3 } : {}) }
  return out
}
