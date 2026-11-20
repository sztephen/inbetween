import { describe, expect, it } from 'vitest'
import { eyeProject, eyeUnproject, firstPersonCamera, restEye } from '@core/firstPerson'
import { qFromEulerDeg, vdist } from '@core/math'
import { computeWorld } from '@core/rig'
import { createR15 } from '@core/r15'
import { makeHarness } from './helpers'

const rig = createR15()

describe('first-person camera', () => {
  it('sits at the rest head position looking forward (-Z), like a root-following game camera', () => {
    const eye = restEye(rig)
    expect(eye.position[0]).toBeCloseTo(0, 3)
    expect(eye.position[1]).toBeCloseTo(4.5, 1) // Roblox: root + 1.5 studs
    expect(eye.forward).toEqual([0, 0, -1])
    expect(eye.fov).toBe(70)
    // It does not move with the body.
    const crouched = computeWorld(rig, { LowerTorso: { q: qFromEulerDeg([20, 40, 0]), p: [0, -1, 0] } })
    expect(firstPersonCamera(rig, crouched, 'first_person').position).toEqual(eye.position)
  })

  it('head_cam follows the animated head position and rotation', () => {
    const turned = computeWorld(rig, { Head: { q: qFromEulerDeg([0, 90, 0]) }, LowerTorso: { q: [0, 0, 0, 1], p: [0, -1, 0] } })
    const cam = firstPersonCamera(rig, turned, 'head_cam')
    expect(cam.position[1]).toBeLessThan(3.8)
    // +Y rotation of 90 degrees turns -Z forward toward -X (the character's left).
    expect(cam.forward[0]).toBeCloseTo(-1, 4)
    expect(cam.forward[2]).toBeCloseTo(0, 4)
    expect(cam.up[1]).toBeCloseTo(1, 4)
  })

  it('projects and unprojects consistently; right of the character is right of the picture', () => {
    const eye = restEye(rig)
    const p = eyeUnproject(eye, 0.45, -0.5, 1.6, 16 / 9)
    expect(p[0]).toBeGreaterThan(0) // +X is the character's right
    expect(p[1]).toBeLessThan(eye.position[1])
    expect(p[2]).toBeCloseTo(-1.6, 2)
    const back = eyeProject(eye, p, 16 / 9)
    expect(back.x).toBeCloseTo(0.45, 5)
    expect(back.y).toBeCloseTo(-0.5, 5)
    expect(back.depth).toBeCloseTo(1.6, 5)
    expect(back.visible).toBe(true)
    expect(eyeProject(eye, [0, 4.5, 3], 16 / 9).visible).toBe(false) // behind the eye
    expect(eyeProject(eye, [1.5, 2.4, 0], 16 / 9).visible).toBe(false) // hand hanging at the side
  })
})

describe('first-person posing and preview through the tools', () => {
  it('places a hand by its position in the first-person picture and reports visibility', async () => {
    const h = makeHarness()
    const info = await h.call('get_rig')
    expect(info.first_person.fov_deg).toBe(70)
    await h.call('set_pose', { frame: 0 })
    const posed = await h.call('set_pose', { frame: 10, goals: { right_hand: { view: [0.45, -0.5, 1.6], pole: [2.5, 1, 1] } } })
    expect(posed.warnings).toBeUndefined()
    const eye = restEye(rig)
    expect(vdist(posed.effectors.right_hand, eyeUnproject(eye, 0.45, -0.5, 1.6, 16 / 9))).toBeLessThan(0.02)

    const res = await h.raw('preview', { frames: [0, 10], views: ['first_person', 'side'] })
    expect(res.isError).toBeFalsy()
    expect(res.images).toHaveLength(1)
    expect(h.previews[0].subjectRigId).toBe('r15')
    const vis = JSON.parse(res.text).first_person_visibility.first_person
    expect(vis.f0.right_hand).not.toMatch(/in view/)
    expect(vis.f10.right_hand).toMatch(/^in view at x 0\.45, y -0\.5, 1\.6 ahead$/)
    expect(vis.f10.left_hand).not.toMatch(/in view/)

    const door = await h.call('add_rig', { type: 'prop', preset: 'door' })
    const bad = await h.raw('preview', { views: ['first_person'], rig: door.added.id })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/no head bone/)
    const noGoal = await h.raw('set_pose', { rig: 'r15', frame: 3, goals: { right_hand: {} } })
    expect(noGoal.text).toMatch(/needs a position or a view/)
  })
})
