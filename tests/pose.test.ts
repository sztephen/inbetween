import { describe, expect, it } from 'vitest'
import { solveChain } from '@core/ik'
import { qangle, qFromEulerDeg, vdist } from '@core/math'
import { applyGoals, mirrorPose } from '@core/pose'
import { computeWorld, effectorWorld, getChain, mirrorName } from '@core/rig'
import { createR15 } from '@core/r15'
import type { Pose } from '@core/types'

const rig = createR15()

describe('pose mirroring', () => {
  it('maps names left<->right', () => {
    expect(mirrorName('LeftUpperArm')).toBe('RightUpperArm')
    expect(mirrorName('right_hand')).toBe('left_hand')
    expect(mirrorName('Head')).toBe('Head')
    expect(mirrorName('Arm.L')).toBe('Arm.R')
  })

  it('mirrors world positions across the centre plane', () => {
    const pose: Pose = { LowerTorso: { q: qFromEulerDeg([5, 25, -8]), p: [0.3, -0.4, 0.2] }, UpperTorso: { q: qFromEulerDeg([10, -15, 6]) }, Head: { q: qFromEulerDeg([0, 30, 5]) } }
    solveChain(rig, pose, getChain(rig, 'right_hand'), { position: [1.4, 3.8, -1.0] })
    solveChain(rig, pose, getChain(rig, 'left_foot'), { position: [-0.7, 0.4, -0.6] })
    const m = mirrorPose(rig, pose)
    const a = computeWorld(rig, pose), b = computeWorld(rig, m)
    for (const bone of rig.bones) {
      const partner = mirrorName(bone.name)
      const pa = a.bone[bone.name].p, pb = b.bone[partner].p
      expect(vdist([-pa[0], pa[1], pa[2]], pb)).toBeLessThan(1e-3)
    }
    const rh = effectorWorld(rig, a, getChain(rig, 'right_hand'))
    const lh = effectorWorld(rig, b, getChain(rig, 'left_hand'))
    expect(vdist([-rh[0], rh[1], rh[2]], lh)).toBeLessThan(1e-3)
  })

  it('mirroring twice returns the original pose', () => {
    const pose: Pose = { LowerTorso: { q: qFromEulerDeg([5, 25, -8]), p: [0.3, -0.4, 0.2] }, RightUpperArm: { q: qFromEulerDeg([40, 10, 30]) }, LeftFoot: { q: qFromEulerDeg([-20, 5, 3]) } }
    const back = mirrorPose(rig, mirrorPose(rig, pose))
    for (const k in pose) {
      expect(qangle(pose[k].q, back[k].q)).toBeLessThan(1e-4)
      if (pose[k].p) expect(vdist(pose[k].p!, back[k].p!)).toBeLessThan(1e-9)
    }
  })

  it('a symmetric pose is unchanged by mirroring', () => {
    const pose: Pose = { RightUpperArm: { q: qFromEulerDeg([30, 0, 20]) }, LeftUpperArm: { q: qFromEulerDeg([30, 0, -20]) } }
    const m = mirrorPose(rig, pose)
    expect(qangle(m.RightUpperArm.q, pose.RightUpperArm.q)).toBeLessThan(1e-6)
    expect(qangle(m.LeftUpperArm.q, pose.LeftUpperArm.q)).toBeLessThan(1e-6)
  })
})

describe('goal posing', () => {
  it('lowering the hips keeps both feet planted and bends the knees', () => {
    const pose: Pose = {}
    const rep = applyGoals(rig, pose, { hips: { position: [0, -0.6, 0] } })
    const w = computeWorld(rig, pose)
    expect(rep.keptFeet.sort()).toEqual(['left_foot', 'right_foot'])
    expect(effectorWorld(rig, w, getChain(rig, 'left_foot'))[1]).toBeCloseTo(0, 2)
    expect(effectorWorld(rig, w, getChain(rig, 'right_foot'))[1]).toBeCloseTo(0, 2)
    expect(w.joint.RightLowerLeg.p[2]).toBeLessThan(-0.2) // knees forward
  })
  it('keep_feet=false lets the feet travel with the hips', () => {
    const pose: Pose = {}
    applyGoals(rig, pose, { hips: { position: [0, 1, 0] }, keepFeet: false })
    expect(effectorWorld(rig, computeWorld(rig, pose), getChain(rig, 'left_foot'))[1]).toBeCloseTo(1, 3)
  })
  it('reports unreachable goals', () => {
    const pose: Pose = {}
    const rep = applyGoals(rig, pose, { goals: { right_hand: { position: [9, 9, 9] } } })
    expect(rep.ik[0].reached).toBe(false)
  })
})
