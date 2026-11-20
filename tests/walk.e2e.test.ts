import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRbxmx } from '@core/export/rbxmx'
import { makeHarness } from './helpers'

// End-to-end: drive the tool registry the way an AI client would, through a scripted walk cycle,
// and require the validators to pass.
describe('scripted walk cycle through the tool registry', () => {
  it('builds a looping walk that passes check, previews, and exports', async () => {
    const h = makeHarness()
    const rig = await h.call('get_rig')
    expect(rig.ik_chains.map((c: { name: string }) => c.name)).toContain('left_foot')
    expect(rig.dimensions.height).toBeGreaterThan(5)

    const made = await h.call('create_clip', { name: 'Walk', length: 24, fps: 30, loop: true, priority: 'Movement' })
    expect(made.created.loop).toBe(true)

    // Half a cycle: right foot planted and travelling back, left foot swinging forward.
    const half = [
      { frame: 0, hips: -0.28, right: [0.5, 0, -0.7], left: [-0.5, 0.3, 0.6], leftRot: [-35, 0, 0], armR: -22, armL: 22 },
      { frame: 3, hips: -0.36, right: [0.5, 0, -0.383], left: [-0.5, 0.5, 0.6], leftRot: [-40, 0, 0], armR: -12, armL: 12 },
      { frame: 6, hips: -0.2, right: [0.5, 0, -0.067], left: [-0.5, 0.42, 0.1], leftRot: [-10, 0, 0], armR: 0, armL: 0 },
      { frame: 9, hips: -0.16, right: [0.5, 0, 0.25], left: [-0.5, 0.2, -0.55], leftRot: [12, 0, 0], armR: 12, armL: -12 }
    ]
    for (const k of half) {
      const res = await h.call('set_pose', {
        frame: k.frame, timing: 'linear',
        hips: { position: [0, k.hips, 0], rotation: [3, 0, 0] },
        goals: { right_foot: { position: k.right }, left_foot: { position: k.left, rotation: k.leftRot } },
        bones: {
          RightUpperArm: { rotation: [k.armR, 0, 4] }, LeftUpperArm: { rotation: [k.armL, 0, -4] },
          RightLowerArm: { rotation: [12, 0, 0] }, LeftLowerArm: { rotation: [12, 0, 0] }
        }
      })
      expect(res.warnings, `frame ${k.frame}: ${JSON.stringify(res.warnings)}`).toBeUndefined()
      expect(res.keyed_bones).toBe(15)
    }
    // Second half is the mirror image; close the loop with a copy of frame 0.
    for (const f of [0, 3, 6, 9]) await h.call('mirror_pose', { frame: f, to_frame: f + 12 })
    await h.call('copy_pose_to_frame', { from_frame: 0, to_frame: 24 })
    // Plant each foot for its stance phase, sliding back like a treadmill.
    // After frame 9 the heel peels off toward the toe-off pose, so the pin ends there.
    const c1 = await h.call('add_contact', { chain: 'right_foot', start: 0, end: 9, position: [0.5, 0, -0.7], slide: [0, 0, 0.95] })
    const c2 = await h.call('add_contact', { chain: 'left_foot', start: 12, end: 21, position: [-0.5, 0, -0.7], slide: [0, 0, 0.95] })
    expect(c1.holds).toBe(true)
    expect(c2.holds).toBe(true)
    await h.call('add_marker', { name: 'footstep', frame: 0 })
    await h.call('add_marker', { name: 'footstep', frame: 12 })

    const check = await h.call('check')
    expect(check.problems, JSON.stringify(check.problems, null, 1)).toEqual([])
    expect(check.ok).toBe(true)

    const clip = await h.call('get_clip', { frame: 12 })
    expect(clip.rigs[0].full_pose_key_frames).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24])
    expect(clip.contacts).toHaveLength(2)
    // At frame 12 the mirrored pose has the left foot forward.
    expect(clip.pose.effectors.left_foot[2]).toBeCloseTo(-0.7, 1)
    expect(clip.pose.effectors.right_foot[2]).toBeCloseTo(0.6, 1)
    expect(clip.pose.active_contacts).toEqual(['left_foot'])

    const prev = await h.raw('preview', { frames: 'keys', views: ['front', 'side'], onion_skin: true, trails: ['left_foot'] })
    expect(prev.isError).toBeFalsy()
    expect(prev.images).toHaveLength(1)
    expect(h.previews[0].frames).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24])
    expect(h.previews[0].trails).toEqual(['left_foot'])

    const exp = await h.call('export', { format: 'rbxmx' })
    expect(existsSync(exp.exported)).toBe(true)
    const seq = parseRbxmx(readFileSync(exp.exported, 'utf8'))
    expect(seq.loop).toBe(true)
    expect(seq.priority).toBe(1)
    expect(seq.keyframes.filter((k) => k.markers.length)).toHaveLength(2)
    const glb = await h.call('export', { format: 'glb' })
    expect(readFileSync(glb.exported).subarray(0, 4).toString()).toBe('glTF')
  })
})
