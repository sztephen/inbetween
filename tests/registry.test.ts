import { describe, expect, it } from 'vitest'
import { getClip, getRig } from '@core/clip'
import { opSetBone } from '@core/ops'
import { qFromEulerDeg } from '@core/math'
import { makeHarness } from './helpers'

describe('tool registry', () => {
  it('lists every tool with a JSON schema and a real description', () => {
    const h = makeHarness()
    const list = h.registry.list()
    const names = list.map((t) => t.name)
    for (const n of ['get_rig', 'get_clip', 'list_clips', 'create_clip', 'set_pose', 'save_pose', 'load_pose', 'mirror_pose', 'list_poses',
      'copy_pose_to_frame', 'set_timing', 'add_contact', 'add_marker', 'set_camera', 'preview', 'check', 'export', 'undo']) expect(names).toContain(n)
    for (const t of list) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.description.length).toBeGreaterThan(40)
    }
    const setPose = list.find((t) => t.name === 'set_pose')!
    expect(JSON.stringify(setPose.inputSchema)).toContain('"frame"')
    expect((setPose.inputSchema.required as string[])).toContain('frame')
  })

  it('returns errors the model can act on instead of throwing', async () => {
    const h = makeHarness()
    const bad = await h.raw('set_pose', { frame: -1 })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/Invalid arguments for set_pose: frame/)
    const unknown = await h.raw('nope')
    expect(unknown.isError).toBe(true)
    const chain = await h.raw('set_pose', { frame: 0, goals: { third_hand: { position: [0, 0, 0] } } })
    expect(chain.isError).toBe(true)
    expect(chain.text).toMatch(/Unknown IK chain "third_hand".*right_hand/)
    const far = await h.call('set_pose', { frame: 0, goals: { right_hand: { position: [9, 9, 9] } } })
    expect(far.warnings[0]).toMatch(/right_hand: missed target/)
  })

  it('undo and redo cover AI edits and manual edits in one history', async () => {
    const h = makeHarness()
    await h.call('set_pose', { frame: 5, bones: { Head: { rotation: [0, 30, 0] } } })
    h.store.mutate('user', 'rotated Head at frame 8', (p) => opSetBone(getClip(p), getRig(p), 8, 'Head', qFromEulerDeg([0, -20, 0])))
    const frames = (): number[] => (getClip(h.store.project).tracks.r15?.Head ?? []).map((k) => k.frame)
    expect(frames()).toEqual([5, 8])
    expect((await h.call('undo')).undone).toEqual(['rotated Head at frame 8'])
    expect(frames()).toEqual([5])
    await h.call('undo')
    expect(frames()).toEqual([])
    await h.call('undo', { redo: true, steps: 2 })
    expect(frames()).toEqual([5, 8])
  })

  it('tells the AI once about manual edits made since its last call', async () => {
    const h = makeHarness()
    await h.call('set_pose', { frame: 5, bones: { Head: { rotation: [0, 30, 0] } } })
    h.store.mutate('user', 'rotated RightUpperArm at frame 5', (p) => opSetBone(getClip(p), getRig(p), 5, 'RightUpperArm', qFromEulerDeg([40, 0, 0])))
    const first = await h.raw('list_clips')
    expect(first.text).toMatch(/NOTE: the user made manual edits.*\n- rotated RightUpperArm at frame 5/s)
    const second = await h.raw('list_clips')
    expect(second.text).not.toMatch(/NOTE/)
  })

  it('timing: moves, holds with ripple, easing presets', async () => {
    const h = makeHarness()
    for (const f of [0, 10, 20]) await h.call('set_pose', { frame: f, bones: { Head: { rotation: [0, f, 0] } }, timing: 'stepped' })
    await h.call('add_marker', { name: 'hit', frame: 20 })
    const r = await h.call('set_timing', { moves: [{ from: 10, to: 6 }], holds: [{ frame: 6, duration: 4, ripple: true }], easing: [{ frames: 'all', timing: 'snappy' }, { frames: [6], timing: 'stepped' }] })
    expect(r.key_frames).toEqual([0, 6, 10, 24])
    const clip = getClip(h.store.project)
    expect(clip.markers[0].frame).toBe(24)
    const head = clip.tracks.r15.Head
    expect(head.map((k) => k.ease)).toEqual(['cubic', 'constant', 'cubic', 'cubic'])
    expect(head[0].dir).toBe('out')
    expect(head[1].q).toEqual(head[2].q)
  })

  it('pose library, props, camera and scene tools', async () => {
    const h = makeHarness()
    await h.call('set_pose', { frame: 0, goals: { right_hand: { position: [1.4, 4.2, -0.8] } } })
    await h.call('save_pose', { name: 'reach', frame: 0 })
    expect((await h.call('list_poses')).poses).toEqual(['reach'])
    await h.call('load_pose', { name: 'reach', frame: 10, mirror: true })
    const at10 = await h.call('get_clip', { frame: 10 })
    expect(at10.pose.effectors.left_hand[0]).toBeCloseTo(-1.4, 1)
    expect(at10.pose.effectors.left_hand[1]).toBeCloseTo(4.2, 1)

    const door = await h.call('add_rig', { type: 'prop', preset: 'door', position: [0, 0, -4] })
    expect(door.added.bones).toEqual(['Frame', 'Door'])
    await h.call('set_pose', { rig: door.added.id, frame: 0, bones: { Door: { rotation: [0, 0, 0] } } })
    const swung = await h.call('set_pose', { rig: door.added.id, frame: 20, bones: { Door: { rotation: [0, 200, 0] } } })
    expect(swung.warnings[0]).toMatch(/clamped to joint limits on: Door/)
    const custom = await h.call('add_rig', { type: 'prop', name: 'Crane', parts: [{ name: 'Base', size: [2, 1, 2], position: [5, 0.5, 0] }, { name: 'Arm', parent: 'Base', size: [0.5, 4, 0.5], position: [0, 2.5, 0], pivot: [0, 0.5, 0] }] })
    expect(custom.added.bones).toEqual(['Base', 'Arm'])

    await h.call('set_camera', { frame: 0, position: [6, 4, -8], target: [0, 3, 0], fov: 40 })
    await h.call('set_camera', { frame: 20, position: [2, 3, -6] })
    const clip = await h.call('get_clip')
    expect(clip.camera_keys).toHaveLength(2)
    expect(clip.camera_keys[1].target).toEqual([0, 3, 0])
    const scene = await h.call('get_scene')
    expect(scene.rigs).toHaveLength(3)
    const check = await h.call('check')
    expect(Array.isArray(check.problems)).toBe(true)
    const noCam = await h.raw('export', { format: 'mp4', background: 'transparent' })
    expect(noCam.text).toMatch(/cannot store transparency/)
  })
})
