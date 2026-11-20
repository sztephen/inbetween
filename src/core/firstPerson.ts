import { restBonePos, restBoneRot } from './ik'
import { qinv, qmul, qrot, vadd, vcross, vdot, vnorm, vsub, xpoint, type Vec3 } from './math'
import { computeWorld, effectorWorld, type WorldPose } from './rig'
import type { Clip, Pose, Rig } from './types'
import { evaluateRig } from './clip'

/** Roblox's default camera field of view (vertical, degrees). */
export const FIRST_PERSON_FOV = 70

export type FirstPersonMode = 'first_person' | 'head_cam'

export interface EyeCamera {
  position: Vec3
  forward: Vec3
  up: Vec3
  fov: number
}

/**
 * The camera a player sees through in first person.
 * - first_person: fixed at the rest head position, looking straight ahead. This matches a game
 *   camera that follows the character root (Roblox's default), so body motion does not move the view.
 * - head_cam: locked to the animated head, position and rotation, for games that attach the
 *   camera to the head (shows head bob and tilt).
 */
export function firstPersonCamera(rig: Rig, world: WorldPose, mode: FirstPersonMode): EyeCamera {
  if (!rig.head) throw new Error(`"${rig.name}" has no head bone, so it has no first-person view.`)
  const fwdRig = rig.forward ?? [0, 0, -1]
  if (mode === 'first_person') {
    return {
      position: xpoint(rig.origin, restBonePos(rig, rig.head)),
      forward: vnorm(qrot(rig.origin.q, fwdRig)), up: vnorm(qrot(rig.origin.q, [0, 1, 0])), fov: FIRST_PERSON_FOV
    }
  }
  const head = world.bone[rig.head]
  // Head's rotation relative to its rest orientation, applied to the rig's forward/up.
  const delta = qmul(head.q, qinv(qmul(rig.origin.q, restBoneRot(rig, rig.head))))
  return {
    position: head.p,
    forward: vnorm(qrot(delta, qrot(rig.origin.q, fwdRig))), up: vnorm(qrot(delta, qrot(rig.origin.q, [0, 1, 0]))), fov: FIRST_PERSON_FOV
  }
}

/**
 * Where a scene point lands in the eye camera's frame: x and y in [-1, 1] are inside the picture
 * (x right, y up), `depth` is distance in front of the eye. Not visible when depth <= near.
 */
export function eyeProject(cam: EyeCamera, point: Vec3, aspect = 1): { x: number; y: number; depth: number; visible: boolean } {
  const right = vnorm(vcross(cam.forward, cam.up))
  const up = vcross(right, cam.forward)
  const d = vsub(point, cam.position)
  const depth = vdot(d, cam.forward)
  const t = Math.tan((cam.fov * Math.PI) / 360)
  const x = depth > 1e-6 ? vdot(d, right) / (depth * t * aspect) : 0
  const y = depth > 1e-6 ? vdot(d, up) / (depth * t) : 0
  return { x, y, depth, visible: depth > 0.1 && Math.abs(x) <= 1 && Math.abs(y) <= 1 }
}

/** For each frame, which IK effectors (hands, feet) are inside the first-person picture, and where. */
export function effectorsInView(clip: Clip, rig: Rig, frames: number[], mode: FirstPersonMode, aspect = 1): Record<number, Record<string, { visible: boolean; x: number; y: number; depth: number }>> {
  const out: Record<number, Record<string, { visible: boolean; x: number; y: number; depth: number }>> = {}
  for (const f of frames) {
    const world = computeWorld(rig, evaluateRig(clip, rig, f))
    const cam = firstPersonCamera(rig, world, mode)
    out[f] = {}
    for (const c of rig.chains) {
      const p = eyeProject(cam, effectorWorld(rig, world, c), aspect)
      out[f][c.name] = { visible: p.visible, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, depth: Math.round(p.depth * 100) / 100 }
    }
  }
  return out
}

/** A scene point at a position in the first-person picture: x, y in [-1, 1], `depth` units in front of the eye. */
export function eyeUnproject(cam: EyeCamera, x: number, y: number, depth: number, aspect = 1): Vec3 {
  const right = vnorm(vcross(cam.forward, cam.up))
  const up = vcross(right, cam.forward)
  const t = Math.tan((cam.fov * Math.PI) / 360)
  return vadd(cam.position, vadd(
    [cam.forward[0] * depth, cam.forward[1] * depth, cam.forward[2] * depth],
    vadd([right[0] * x * depth * t * aspect, right[1] * x * depth * t * aspect, right[2] * x * depth * t * aspect], [up[0] * y * depth * t, up[1] * y * depth * t, up[2] * y * depth * t])
  ))
}

export function restEye(rig: Rig): EyeCamera {
  return firstPersonCamera(rig, computeWorld(rig, {} as Pose), 'first_person')
}
