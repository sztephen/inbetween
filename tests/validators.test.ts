import { describe, expect, it } from 'vitest'
import { createClip, writePoseKeys } from '@core/clip'
import { qFromEulerDeg } from '@core/math'
import { opAddContact, opSetPose } from '@core/ops'
import { createR15 } from '@core/r15'
import type { Clip, Pose } from '@core/types'
import { checkClip, obbPenetration } from '@core/validators'

const rig = createR15()
const rest = (): Pose => Object.fromEntries(rig.bones.filter((b) => !b.locked).map((b) => [b.name, { q: [0, 0, 0, 1] }])) as Pose
const clipWith = (length = 20, loop = false): Clip => {
  const c = createClip('t', length, 30, loop)
  writePoseKeys(c, rig, 0, rest())
  writePoseKeys(c, rig, length, rest())
  return c
}
const names = (c: Clip, check?: string): string[] => checkClip(c, rig).filter((p) => !check || p.check === check).map((p) => `${p.check}:${p.subject}`)

describe('validators', () => {
  it('a clean rest clip has no problems', () => {
    expect(checkClip(clipWith(), rig)).toEqual([])
  })

  it('foot_sliding: flags a contact the leg cannot hold, passes one it can', () => {
    const c = clipWith()
    opAddContact(c, rig, 'left_foot', 0, 20)
    expect(names(c, 'foot_sliding')).toEqual([])
    // Lift the hips far out of reach mid-clip: the planted foot must come off its pin.
    opSetPose({ clip: c, rig, frame: 10, spec: { hips: { position: [0, 2.5, 0] }, keepFeet: false } })
    const probs = checkClip(c, rig).filter((p) => p.check === 'foot_sliding')
    expect(probs).toHaveLength(1)
    expect(probs[0].subject).toBe('left_foot')
    expect(probs[0].frames[0]).toBeGreaterThan(0)
    expect(probs[0].frames[1]).toBeLessThan(20)
    expect(probs[0].amount).toBeGreaterThan(0.5)
  })

  it('foot_sliding: a sliding contact follows its moving target', () => {
    const c = clipWith()
    opSetPose({ clip: c, rig, frame: 0, spec: { hips: { position: [0, -0.3, 0] } } })
    opSetPose({ clip: c, rig, frame: 20, spec: { hips: { position: [0, -0.3, 0] } } })
    opAddContact(c, rig, 'right_foot', 0, 20, { position: [0.5, 0, -0.6], slide: [0, 0, 1.2] })
    expect(names(c, 'foot_sliding')).toEqual([])
  })

  it('joint_limits: flags a hyperextended elbow with the frame range', () => {
    const c = clipWith()
    const bad = rest()
    bad.RightLowerArm = { q: qFromEulerDeg([-40, 0, 0]) }
    writePoseKeys(c, rig, 10, bad)
    const probs = checkClip(c, rig).filter((p) => p.check === 'joint_limits')
    expect(probs.map((p) => p.subject)).toEqual(['RightLowerArm'])
    expect(probs[0].frames[0]).toBeLessThanOrEqual(10)
    expect(probs[0].frames[1]).toBeGreaterThanOrEqual(10)
    expect(probs[0].amount).toBeCloseTo(40, 0)
    expect(probs[0].message).toMatch(/X limit/)
  })

  it('self_intersection: flags a hand pushed through the torso', () => {
    const c = clipWith()
    const bad = rest()
    bad.RightUpperArm = { q: qFromEulerDeg([0, 0, -35]) }
    bad.RightLowerArm = { q: qFromEulerDeg([0, 0, 0]) }
    writePoseKeys(c, rig, 10, bad)
    const hits = names(c, 'self_intersection')
    expect(hits.some((h) => /RightLowerArm|RightHand/.test(h))).toBe(true)
  })

  it('obb penetration depth', () => {
    const box = (x: number) => ({ c: [x, 0, 0] as [number, number, number], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as never, h: [0.5, 0.5, 0.5] as [number, number, number] })
    expect(obbPenetration(box(0), box(2))).toBe(0)
    expect(obbPenetration(box(0), box(0.75))).toBeCloseTo(0.25, 6)
  })

  it('jitter: flags a one-frame back-and-forth, ignores smooth motion and stepped holds', () => {
    const smooth = clipWith()
    const up = rest()
    up.RightUpperArm = { q: qFromEulerDeg([80, 0, 0]) }
    writePoseKeys(smooth, rig, 10, up)
    expect(names(smooth, 'jitter')).toEqual([])

    const shaky = clipWith()
    for (let f = 5; f <= 9; f++) {
      const p = rest()
      p.RightUpperArm = { q: qFromEulerDeg([f % 2 ? 25 : -25, 0, 0]) }
      writePoseKeys(shaky, rig, f, p)
    }
    expect(names(shaky, 'jitter')).toContain('jitter:RightUpperArm')
    // Children of the jittering bone are not reported separately.
    expect(names(shaky, 'jitter')).not.toContain('jitter:RightHand')

    const stepped = clipWith()
    for (let f = 5; f <= 9; f++) {
      const p = rest()
      p.RightUpperArm = { q: qFromEulerDeg([f % 2 ? 25 : -25, 0, 0]) }
      writePoseKeys(stepped, rig, f, p, { ease: 'constant', dir: 'inout' })
    }
    expect(names(stepped, 'jitter')).toEqual([])
  })

  it('jitter: flags a single-frame teleport as a velocity spike', () => {
    const c = clipWith()
    const far = rest()
    far.LowerTorso = { q: [0, 0, 0, 1], p: [0, 3.5, 0] }
    writePoseKeys(c, rig, 10, far)
    const back = rest()
    back.LowerTorso = { q: [0, 0, 0, 1], p: [0, 0, 0] }
    writePoseKeys(c, rig, 9, back)
    const probs = checkClip(c, rig).filter((p) => p.check === 'jitter')
    expect(probs.length).toBeGreaterThan(0)
    expect(probs[0].message).toMatch(/velocity spike/)
  })

  it('loop_mismatch: only for looping clips whose ends differ', () => {
    const c = clipWith(20, true)
    expect(names(c, 'loop_mismatch')).toEqual([])
    const end = rest()
    end.Head = { q: qFromEulerDeg([0, 30, 0]) }
    writePoseKeys(c, rig, 20, end)
    expect(names(c, 'loop_mismatch')).toEqual(['loop_mismatch:Head'])
    c.loop = false
    expect(names(c, 'loop_mismatch')).toEqual([])
  })

  it('ground_penetration: flags feet pushed under the ground', () => {
    const c = clipWith()
    opSetPose({ clip: c, rig, frame: 10, spec: { hips: { position: [0, -0.2, 0] }, keepFeet: false } })
    const probs = checkClip(c, rig).filter((p) => p.check === 'ground_penetration')
    expect(probs.map((p) => p.subject).sort()).toEqual(['LeftFoot', 'RightFoot'])
    expect(probs[0].amount).toBeCloseTo(0.2, 1)
  })
})

describe('balance and timing', () => {
  it('balance: flags a held pose with the weight far in front of the feet, not a centred one', () => {
    const c = clipWith()
    expect(names(c, 'balance')).toEqual([])
    const lean = (f: number): void => void opSetPose({ clip: c, rig, frame: f, spec: { hips: { position: [0, -0.2, -1] } } })
    lean(0)
    lean(20)
    const probs = checkClip(c, rig).filter((p) => p.check === 'balance')
    expect(probs).toHaveLength(1)
    expect(probs[0].message).toMatch(/forward/)
    expect(probs[0].severity).toBe('warning')
  })

  it('balance: a pose the character only moves through is not flagged', () => {
    const c = clipWith()
    opSetPose({ clip: c, rig, frame: 10, spec: { hips: { position: [0, -0.2, -1] } } })
    expect(names(c, 'balance')).toEqual([])
  })
})
