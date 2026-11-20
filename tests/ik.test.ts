import { describe, expect, it } from 'vitest'
import { clampToLimits, limitViolation, lookAt, solveChain } from '@core/ik'
import { qFromEulerDeg, qToEulerDeg, vdist, vsub, vnorm, vdot, qrot, type Vec3 } from '@core/math'
import { computeWorld, effectorWorld, getBone, getChain, restWorld } from '@core/rig'
import { createR15 } from '@core/r15'
import type { Pose } from '@core/types'

const rig = createR15()
const rest = restWorld(rig)

describe('R15 rig', () => {
  it('stands on the ground with real proportions', () => {
    const lf = effectorWorld(rig, rest, getChain(rig, 'left_foot'))
    const rf = effectorWorld(rig, rest, getChain(rig, 'right_foot'))
    expect(lf[1]).toBeCloseTo(0, 3)
    expect(rf[1]).toBeCloseTo(0, 3)
    expect(lf[0]).toBeCloseTo(-0.5, 3)
    expect(rest.bone.Head.p[1]).toBeGreaterThan(4.3)
    expect(rig.bones).toHaveLength(16)
  })
})

describe('two-bone IK', () => {
  const targets: Record<string, Vec3[]> = {
    right_hand: [[1.2, 3.5, -1.2], [0.4, 4.6, -0.9], [2.4, 3.9, 0.2], [1.5, 2.6, -0.6], [0.2, 3.2, -1.3], [1.5, 5.2, -0.2]],
    left_hand: [[-1.2, 3.5, -1.2], [-2.2, 4.4, -0.3]],
    right_foot: [[0.5, 0.6, -0.9], [0.7, 0.2, 0.6], [0.5, 0.6, 0]],
    left_foot: [[-0.5, 0.3, -1.0], [-0.9, 0.2, 0.3]]
  }
  for (const chainName in targets) {
    for (const t of targets[chainName]) {
      it(`${chainName} reaches ${t.join(',')}`, () => {
        const pose: Pose = {}
        const res = solveChain(rig, pose, getChain(rig, chainName), { position: t })
        const w = computeWorld(rig, pose)
        expect(vdist(effectorWorld(rig, w, getChain(rig, chainName)), t)).toBeLessThan(0.03)
        expect(res.reached).toBe(true)
        // Solved joints stay inside their limits.
        for (const b of getChain(rig, chainName).bones) {
          expect(limitViolation(getBone(rig, b), pose[b]?.q ?? [0, 0, 0, 1], 0.01)).toBeNull()
        }
      })
    }
  }

  it('elbows bend the right way: forearm folds forward, elbow points back', () => {
    const pose: Pose = {}
    solveChain(rig, pose, getChain(rig, 'right_hand'), { position: [1.2, 3.6, -1.0] })
    const e = qToEulerDeg(pose.RightLowerArm.q)
    expect(e[0]).toBeGreaterThan(5) // positive X = flexion
    const w = computeWorld(rig, pose)
    const shoulder = w.joint.RightUpperArm.p, elbow = w.joint.RightLowerArm.p, hand = w.bone.RightHand.p
    const mid: Vec3 = [(shoulder[0] + hand[0]) / 2, (shoulder[1] + hand[1]) / 2, (shoulder[2] + hand[2]) / 2]
    expect(elbow[2]).toBeGreaterThan(mid[2] - 1e-6) // behind the shoulder-hand line (+Z is back)
  })

  it('knees bend forward, never backward', () => {
    const pose: Pose = {}
    solveChain(rig, pose, getChain(rig, 'right_foot'), { position: [0.5, 0.8, 0] })
    expect(qToEulerDeg(pose.RightLowerLeg.q)[0]).toBeLessThan(-5)
    const w = computeWorld(rig, pose)
    expect(w.joint.RightLowerLeg.p[2]).toBeLessThan(w.joint.RightUpperLeg.p[2]) // knee in front (-Z)
  })

  it('honours a pole hint', () => {
    const pose: Pose = {}
    const chain = getChain(rig, 'right_hand')
    solveChain(rig, pose, chain, { position: [1.0, 3.6, -1.2], pole: [1, 0, 0] })
    const w = computeWorld(rig, pose)
    const s = w.joint.RightUpperArm.p, e = w.joint.RightLowerArm.p, h = effectorWorld(rig, w, chain)
    const dir = vnorm(vsub(h, s))
    const toElbow = vsub(e, s)
    const perp = vsub(toElbow, [dir[0] * vdot(toElbow, dir), dir[1] * vdot(toElbow, dir), dir[2] * vdot(toElbow, dir)])
    expect(perp[0]).toBeGreaterThan(0.1) // elbow pushed out to +X
  })

  it('reports unreachable targets and extends fully', () => {
    const pose: Pose = {}
    const res = solveChain(rig, pose, getChain(rig, 'right_hand'), { position: [8, 4, 0] })
    expect(res.reached).toBe(false)
    expect(res.note).toMatch(/beyond full reach/)
    const w = computeWorld(rig, pose)
    expect(effectorWorld(rig, w, getChain(rig, 'right_hand'))[0]).toBeGreaterThan(2.6)
  })

  it('keeps feet level and follows a moved parent', () => {
    const pose: Pose = { LowerTorso: { q: qFromEulerDeg([10, 20, 0]), p: [0.2, -0.6, 0.1] } }
    const chain = getChain(rig, 'left_foot')
    solveChain(rig, pose, chain, { position: [-0.5, 0, 0] })
    const w = computeWorld(rig, pose)
    expect(vdist(effectorWorld(rig, w, chain), [-0.5, 0, 0])).toBeLessThan(0.03)
    const up = qrot(w.bone.LeftFoot.q, [0, 1, 0])
    expect(up[1]).toBeGreaterThan(0.995)
  })
})

describe('joint limits', () => {
  it('clamps rotations outside the limits and leaves legal ones alone', () => {
    const elbow = getBone(rig, 'RightLowerArm')
    const hyper = clampToLimits(elbow, qFromEulerDeg([-40, 0, 0]))
    expect(hyper.clamped).toBe(true)
    expect(qToEulerDeg(hyper.q)[0]).toBeCloseTo(0, 3)
    const ok = clampToLimits(elbow, qFromEulerDeg([90, 0, 0]))
    expect(ok.clamped).toBe(false)
    expect(limitViolation(elbow, qFromEulerDeg([170, 0, 0]))!.amount).toBeCloseTo(20, 3)
    expect(limitViolation(getBone(rig, 'RightLowerLeg'), qFromEulerDeg([30, 0, 0]))!.amount).toBeCloseTo(30, 3)
  })
  it('ball joints use a swing cone and twist range', () => {
    const shoulder = getBone(rig, 'RightUpperArm')
    // Arm raised forward, overhead, and out to the side are all legal.
    for (const e of [[90, 0, 0], [170, 0, 0], [0, 0, 90]] as Vec3[]) expect(limitViolation(shoulder, qFromEulerDeg(e))).toBeNull()
    // Swung across and behind the body is not.
    const bad = qFromEulerDeg([40, 0, -100])
    expect(limitViolation(shoulder, bad)!.axis).toBe('swing')
    const fixed = clampToLimits(shoulder, bad)
    expect(fixed.clamped).toBe(true)
    expect(limitViolation(shoulder, fixed.q, 0.01)).toBeNull()
    // Excess twist about the arm's own length is clamped to the range.
    const twisted = clampToLimits(shoulder, qFromEulerDeg([0, 140, 0]))
    expect(twisted.clamped).toBe(true)
    expect(qToEulerDeg(twisted.q)[1]).toBeCloseTo(90, 2)
  })
  it('euler round trip', () => {
    for (const e of [[10, 20, 30], [-80, 45, 120], [150, -60, -20]] as Vec3[]) {
      const back = qToEulerDeg(qFromEulerDeg(e))
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(e[i], 4)
    }
  })
  it('look_at turns the head toward a point within neck limits', () => {
    const pose: Pose = {}
    lookAt(rig, pose, 'Head', [3, 4.5, -3])
    const w = computeWorld(rig, pose)
    const fwd = qrot(w.bone.Head.q, [0, 0, -1])
    const want = vnorm(vsub([3, 4.5, -3], w.bone.Head.p))
    expect(vdot(fwd, want)).toBeGreaterThan(0.99)
    const far: Pose = {}
    const r = lookAt(rig, far, 'Head', [0, 4.5, 5]) // directly behind: must clamp
    expect(r.clamped).toBe(true)
    expect(Math.abs(qToEulerDeg(far.Head.q)[1])).toBeLessThanOrEqual(80.01)
  })
})
