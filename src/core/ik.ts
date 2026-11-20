import {
  clamp, qFromAxisAngle, qFromBasisXY, qFromEulerDeg, qToEulerDeg, qinv, qmul, qnorm, qrot, vadd, vcross, vdist, vdot, vlen,
  vnorm, vscale, vsub, xmul, xpoint, type Quat, type Vec3, type Xform
} from './math'
import { computeWorld, effectorWorld, getBone, getChain, localT, parentWorld, restWorld } from './rig'
import type { BoneDef, IKChainDef, Pose, Rig } from './types'

// ---------- joint limits ----------

export interface LimitViolation {
  /** Degrees outside the limit. */
  amount: number
  /** 'X' | 'Y' | 'Z' for Euler limits, 'swing' | 'twist' for cone limits. */
  axis: string
  /** Human-readable allowed range. */
  range: string
}

function swingTwist(q: Quat, axis: Vec3): { swing: Quat; twistDeg: number } {
  const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2]
  const twist = qnorm([axis[0] * d, axis[1] * d, axis[2] * d, q[3]])
  let ang = 2 * Math.atan2(d, q[3]) * (180 / Math.PI)
  if (ang > 180) ang -= 360
  if (ang < -180) ang += 360
  return { swing: qnorm(qmul(q, qinv(twist))), twistDeg: ang }
}

/** Worst limit violation of an animated rotation, or null when it is within limits. */
export function limitViolation(bone: BoneDef, q: Quat, tolDeg = 0): LimitViolation | null {
  if (bone.cone) {
    const c = bone.cone
    const axis = vnorm(c.axis), center = vnorm(c.center)
    const { swing, twistDeg } = swingTwist(q, axis)
    const ang = Math.acos(clamp(vdot(qrot(swing, axis), center), -1, 1)) * (180 / Math.PI)
    const overSwing = ang - c.angle
    const overTwist = twistDeg < c.twist[0] ? c.twist[0] - twistDeg : twistDeg > c.twist[1] ? twistDeg - c.twist[1] : 0
    if (overSwing > tolDeg && overSwing >= overTwist) return { amount: overSwing, axis: 'swing', range: `within ${c.angle} deg of its limit cone` }
    if (overTwist > tolDeg) return { amount: overTwist, axis: 'twist', range: `twist [${c.twist[0]}, ${c.twist[1]}]` }
    return null
  }
  if (!bone.limits) return null
  const e = qToEulerDeg(q)
  let worst: LimitViolation | null = null
  const names = ['X', 'Y', 'Z']
  for (let i = 0; i < 3; i++) {
    const over = e[i] < bone.limits.min[i] ? bone.limits.min[i] - e[i] : e[i] > bone.limits.max[i] ? e[i] - bone.limits.max[i] : 0
    if (over > tolDeg && (!worst || over > worst.amount)) worst = { amount: over, axis: names[i], range: `${names[i]} [${bone.limits.min[i]}, ${bone.limits.max[i]}]` }
  }
  return worst
}

export function clampToLimits(bone: BoneDef, q: Quat): { q: Quat; clamped: boolean } {
  if (bone.cone) {
    const c = bone.cone
    const axis = vnorm(c.axis), center = vnorm(c.center)
    let { swing, twistDeg } = swingTwist(q, axis)
    let clamped = false
    const d = qrot(swing, axis)
    const ang = Math.acos(clamp(vdot(d, center), -1, 1))
    const max = c.angle * (Math.PI / 180)
    if (ang > max + 1e-6) {
      const rotAxis = vcross(d, center)
      if (vlen(rotAxis) > 1e-8) swing = qnorm(qmul(qFromAxisAngle(rotAxis, ang - max), swing))
      clamped = true
    }
    const tw = clamp(twistDeg, c.twist[0], c.twist[1])
    if (Math.abs(tw - twistDeg) > 1e-4) clamped = true
    return clamped ? { q: qnorm(qmul(swing, qFromAxisAngle(axis, tw * (Math.PI / 180)))), clamped } : { q, clamped }
  }
  if (!bone.limits) return { q, clamped: false }
  const e = qToEulerDeg(q)
  let clamped = false
  const c: Vec3 = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    c[i] = clamp(e[i], bone.limits.min[i], bone.limits.max[i])
    if (Math.abs(c[i] - e[i]) > 1e-4) clamped = true
  }
  return clamped ? { q: qFromEulerDeg(c), clamped } : { q, clamped }
}

// ---------- two-bone IK ----------

export interface IKTarget {
  /** Where the chain's effector (tip) should be, scene space. */
  position: Vec3
  /** World orientation for the end bone. */
  rotation?: Quat
  /** Point direction for the middle joint (elbow/knee), scene space direction. */
  pole?: Vec3
}

export interface IKResult {
  chain: string
  /** Distance left between effector and target after solving and clamping. */
  error: number
  reached: boolean
  clamped: string[]
  note?: string
}

const setRot = (pose: Pose, name: string, q: Quat): void => {
  pose[name] = { ...(pose[name] ?? {}), q: qnorm(q) }
}

/**
 * Analytic two-bone solve. Mutates `pose` for the chain's three bones.
 * Works for arbitrary joint offsets: segment vectors are measured by FK with the
 * chain at rest under the current parent, then rotated into the solved triangle.
 */
export function solveChain(
  rig: Rig, pose: Pose, chain: IKChainDef, target: IKTarget,
  opts: { enforceLimits?: boolean } = {}
): IKResult {
  const enforce = opts.enforceLimits ?? true
  const [un, ln, en] = chain.bones
  const ub = getBone(rig, un), lb = getBone(rig, ln), eb = getBone(rig, en)
  const P = parentWorld(rig, pose, un)
  const clampedBones: string[] = []

  // End bone orientation: explicit, level (rest world orientation), or locked to its current local rotation.
  let endWorld: Quat | undefined = target.rotation
  if (!endWorld && chain.levelEnd) {
    endWorld = qmul(rig.origin.q, restBoneRot(rig, en))
  }

  const Ju0 = xmul(P, ub.pre)
  const S = Ju0.p
  const Bu0 = xmul(Ju0, ub.post)
  const Jl0 = xmul(Bu0, lb.pre)
  const E0 = Jl0.p
  const Bl0 = xmul(Jl0, lb.post)
  // Point fixed in the lower bone's frame that we place: the end joint (when the end bone's world
  // orientation is known) or the effector itself (end bone rigidly following the lower bone).
  const tipJ = vadd(eb.post.p, qrot(eb.post.q, chain.tip))
  const endT = localT(pose, en)
  let pL: Vec3
  let goal: Vec3
  let endJointRot: Quat | undefined
  if (endWorld) {
    endJointRot = qmul(endWorld, qinv(eb.post.q))
    pL = eb.pre.p
    goal = vsub(target.position, qrot(endJointRot, tipJ))
  } else {
    pL = vadd(eb.pre.p, qrot(eb.pre.q, vadd(endT.p, qrot(endT.q, tipJ))))
    goal = target.position
  }
  const W0 = xpoint(Bl0, pL)

  // Geometry with the chain at rest under the current parent. The middle joint is a hinge
  // about h; the upper joint is a ball. Offsets may put S, E, W off a straight line (R15
  // shoulders pivot at the torso edge), so solve the hinge angle from the exact distance.
  const a0 = vsub(E0, S), b0 = vsub(W0, E0)
  const restPoleW = qrot(P.q, qrot(qinv(parentRestRot(rig, un)), chain.restPole))
  let h = vcross(restPoleW, b0)
  if (vlen(h) < 1e-6) h = vcross(qrot(P.q, [0, 0, 1]), b0)
  h = vnorm(h, [1, 0, 0])
  const aPar = vdot(a0, h), bPar = vdot(b0, h)
  const aPerp = vsub(a0, vscale(h, aPar)), bPerp = vsub(b0, vscale(h, bPar))
  const la = vlen(aPerp), lb2 = vlen(bPerp)
  const theta0 = Math.atan2(vdot(h, vcross(aPerp, bPerp)), vdot(aPerp, bPerp))
  const base = vdot(a0, a0) + vdot(b0, b0) + 2 * aPar * bPar
  const maxReach = Math.sqrt(Math.max(0, base + 2 * la * lb2))
  const minReach = Math.sqrt(Math.max(0, base - 2 * la * lb2))
  const toGoal = vsub(goal, S)
  const rawDist = vlen(toGoal)
  const dist = clamp(rawDist, minReach + maxReach * 1e-3, maxReach * 0.9998)
  const dir = vnorm(toGoal, vnorm(vsub(W0, S)))
  const C = clamp((dist * dist - base) / (2 * la * lb2 || 1e-9), -1, 1)
  const phi = Math.acos(C) - theta0

  let Tl = qFromAxisAngle(qrot(qinv(Jl0.q), h), phi)
  if (enforce) {
    const c = clampToLimits(lb, Tl)
    if (c.clamped) clampedBones.push(ln)
    Tl = c.q
  }
  setRot(pose, ln, Tl)

  // Limb as a rigid body with the hinge set: vector from S to the placed point, and the
  // direction the middle joint sticks out, both under an un-rotated upper bone.
  const bNow = qrot(qmul(qmul(Jl0.q, Tl), qinv(Jl0.q)), b0)
  const v = vadd(a0, bNow)
  const bendSrc = vcross(v, h)

  // Pole: where the middle joint points. Fall back through alternatives if parallel to the limb.
  const candidates: Vec3[] = []
  if (target.pole) candidates.push(target.pole)
  candidates.push(qrot(P.q, qrot(qinv(parentRestRot(rig, un)), chain.defaultPole)))
  candidates.push(restPoleW, qrot(rig.origin.q, [0, 1, 0]), qrot(rig.origin.q, [0, 0, 1]), qrot(rig.origin.q, [1, 0, 0]))
  let pole: Vec3 = restPoleW
  for (const c of candidates) {
    const n = vnorm(c)
    if (vlen(vsub(n, vscale(dir, vdot(n, dir)))) > 0.08) {
      pole = n
      break
    }
  }

  // Reaching the target matters more than the exact elbow/knee direction: if the upper joint's
  // limits reject the preferred pole, swivel the limb about the root->target line and take the
  // first swivel that fits (or the closest miss).
  const srcBasisInv = qinv(qFromBasisXY(v, bendSrc))
  let Tu: Quat = [0, 0, 0, 1]
  let bestMiss = Infinity
  let upperClamped = false
  for (const swivel of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
    const pl = swivel === 0 ? pole : qrot(qFromAxisAngle(dir, swivel * (Math.PI / 180)), pole)
    const Ru = qmul(qFromBasisXY(dir, pl), srcBasisInv)
    const cand = qmul(qmul(qinv(Ju0.q), Ru), Ju0.q)
    if (!enforce) {
      Tu = cand
      break
    }
    const c = clampToLimits(ub, cand)
    if (!c.clamped) {
      Tu = cand
      upperClamped = false
      break
    }
    const miss = vdist(qrot(qmul(qmul(Ju0.q, c.q), qinv(Ju0.q)), v), vscale(dir, dist))
    if (miss < bestMiss) {
      bestMiss = miss
      Tu = c.q
      upperClamped = true
    }
  }
  if (upperClamped) clampedBones.push(un)
  setRot(pose, un, Tu)
  const Bu = xmul(xmul(Ju0, { p: [0, 0, 0], q: Tu }), ub.post)
  const Jl = xmul(Bu, lb.pre)

  // End bone.
  if (endJointRot) {
    const Bl = xmul(xmul(Jl, { p: [0, 0, 0], q: Tl }), lb.post)
    const Je = xmul(Bl, eb.pre)
    let Te = qmul(qinv(Je.q), endJointRot)
    if (enforce) {
      const c = clampToLimits(eb, Te)
      if (c.clamped) clampedBones.push(en)
      Te = c.q
    }
    setRot(pose, en, Te)
  }

  const world = computeWorld(rig, pose)
  const error = vdist(effectorWorld(rig, world, chain), target.position)
  const tol = Math.max(1e-3, maxReach * 0.01)
  let note: string | undefined
  if (rawDist > maxReach * 0.9995 + tol) note = `target is ${(rawDist - maxReach).toFixed(2)} beyond full reach (${maxReach.toFixed(2)}); limb fully extended`
  else if (rawDist < minReach) note = 'target is too close to the chain root; limb fully folded'
  else if (clampedBones.length && error > tol) note = `joint limits on ${clampedBones.join(', ')} prevented reaching the target`
  return { chain: chain.name, error, reached: error <= tol, clamped: clampedBones, note }
}

const restCache = new WeakMap<Rig, ReturnType<typeof restWorld>>()
function restRigSpace(rig: Rig): ReturnType<typeof restWorld> {
  let r = restCache.get(rig)
  if (!r) {
    r = computeWorld({ ...rig, origin: { p: [0, 0, 0], q: [0, 0, 0, 1] } } as Rig, {})
    restCache.set(rig, r)
  }
  return r
}
/** Rest orientation of a bone frame in rig space. */
export function restBoneRot(rig: Rig, name: string): Quat {
  return restRigSpace(rig).bone[name].q
}
/** Rest orientation of a bone's parent frame in rig space (identity for the root). */
function parentRestRot(rig: Rig, name: string): Quat {
  const b = getBone(rig, name)
  return b.parent ? restRigSpace(rig).bone[b.parent].q : [0, 0, 0, 1]
}
export function restBonePos(rig: Rig, name: string): Vec3 {
  return restRigSpace(rig).bone[name].p
}
export function restJoint(rig: Rig, name: string): Xform {
  return restRigSpace(rig).joint[name]
}

/** Aim a bone's forward axis (rig -Z at rest) at a scene-space point, keeping it upright. */
export function lookAt(rig: Rig, pose: Pose, boneName: string, targetPoint: Vec3, weight = 1): { clamped: boolean } {
  const b = getBone(rig, boneName)
  const P = parentWorld(rig, pose, boneName)
  const J = xmul(P, b.pre)
  const toRig = qinv(restJoint(rig, boneName).q)
  // Rest forward/up of the rig expressed through this joint's current (un-animated) frame.
  const fwd0 = qrot(J.q, qrot(toRig, rig.forward ?? [0, 0, -1]))
  const up0 = qrot(J.q, qrot(toRig, [0, 1, 0]))
  const headPos = xpoint(xmul(J, b.post), [0, 0, 0])
  const dir = vnorm(vsub(targetPoint, headPos), fwd0)
  const up = qrot(rig.origin.q, [0, 1, 0])
  const delta = qmul(qFromBasisXY(dir, up), qinv(qFromBasisXY(fwd0, up0)))
  let T = qmul(qmul(qinv(J.q), delta), J.q)
  if (weight < 1) {
    const w = clamp(weight, 0, 1)
    const half: Quat = [T[0] * w, T[1] * w, T[2] * w, 1 - w + T[3] * w]
    T = qnorm(half)
  }
  const c = clampToLimits(b, T)
  setRot(pose, boneName, c.q)
  return { clamped: c.clamped }
}

/** Solve a named chain. Convenience wrapper. */
export function solveNamedChain(rig: Rig, pose: Pose, chainName: string, target: IKTarget): IKResult {
  return solveChain(rig, pose, getChain(rig, chainName), target)
}

/** Current world orientation of a chain's end bone. */
export function endBoneWorldRot(rig: Rig, pose: Pose, chain: IKChainDef): Quat {
  return computeWorld(rig, pose).bone[chain.bones[2]].q
}
