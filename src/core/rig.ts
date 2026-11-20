import { qid, qmul, qnorm, qrot, vadd, xid, xmul, xpoint, type Quat, type Vec3, type Xform } from './math'
import type { BoneDef, IKChainDef, Pose, Rig } from './types'

const indexCache = new WeakMap<Rig, Map<string, BoneDef>>()

export function boneMap(rig: Rig): Map<string, BoneDef> {
  let m = indexCache.get(rig)
  if (!m) {
    m = new Map(rig.bones.map((b) => [b.name, b]))
    indexCache.set(rig, m)
  }
  return m
}

export function getBone(rig: Rig, name: string): BoneDef {
  const b = boneMap(rig).get(name)
  if (!b) throw new Error(`Unknown bone "${name}" on rig "${rig.name}". Bones: ${rig.bones.map((x) => x.name).join(', ')}`)
  return b
}

export function getChain(rig: Rig, name: string): IKChainDef {
  const c = rig.chains.find((x) => x.name === name)
  if (!c) throw new Error(`Unknown IK chain "${name}" on rig "${rig.name}". Chains: ${rig.chains.map((x) => x.name).join(', ') || '(none)'}`)
  return c
}

/** Bones ordered so parents always come before children. */
export function orderedBones(rig: Rig): BoneDef[] {
  const out: BoneDef[] = []
  const seen = new Set<string>()
  const map = boneMap(rig)
  const visit = (b: BoneDef): void => {
    if (seen.has(b.name)) return
    if (b.parent) {
      const p = map.get(b.parent)
      if (p) visit(p)
    }
    seen.add(b.name)
    out.push(b)
  }
  rig.bones.forEach(visit)
  return out
}

export function childrenOf(rig: Rig, name: string): BoneDef[] {
  return rig.bones.filter((b) => b.parent === name)
}

export function localT(pose: Pose, name: string): Xform {
  const t = pose[name]
  return t ? { p: t.p ?? [0, 0, 0], q: t.q } : xid()
}

export interface WorldPose {
  /** Joint (pivot) frame before the animated transform: world(parent) * pre. */
  joint: Record<string, Xform>
  /** Bone frame: joint * T * post. */
  bone: Record<string, Xform>
}

/** Forward kinematics for the whole rig, in scene space (includes rig.origin). */
export function computeWorld(rig: Rig, pose: Pose): WorldPose {
  const joint: Record<string, Xform> = {}
  const bone: Record<string, Xform> = {}
  for (const b of orderedBones(rig)) {
    const parent = b.parent ? bone[b.parent] : rig.origin
    const j = xmul(parent, b.pre)
    joint[b.name] = j
    bone[b.name] = xmul(xmul(j, localT(pose, b.name)), b.post)
  }
  return { joint, bone }
}

export const restWorld = (rig: Rig): WorldPose => computeWorld(rig, {})

/** World frame of one bone's parent (rig.origin for the root), walking only the ancestors. */
export function parentWorld(rig: Rig, pose: Pose, name: string): Xform {
  const chain: BoneDef[] = []
  let b = getBone(rig, name)
  while (b.parent) {
    b = getBone(rig, b.parent)
    chain.push(b)
  }
  let w = rig.origin
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]
    w = xmul(xmul(xmul(w, c.pre), localT(pose, c.name)), c.post)
  }
  return w
}

/** World position of an IK chain's effector (hand/foot tip point). */
export function effectorWorld(rig: Rig, world: WorldPose, chain: IKChainDef): Vec3 {
  return xpoint(world.bone[chain.bones[2]], chain.tip)
}

export function clonePose(pose: Pose): Pose {
  const out: Pose = {}
  for (const k in pose) out[k] = { q: [...pose[k].q] as Quat, ...(pose[k].p ? { p: [...pose[k].p!] as Vec3 } : {}) }
  return out
}

/** Axis-aligned bounds of the rig's shapes in a pose (scene space). */
export function rigBounds(rig: Rig, world: WorldPose): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  const grow = (p: Vec3): void => {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
  }
  for (const b of rig.bones) {
    const w = world.bone[b.name]
    if (b.shape) {
      const h = b.shape.size.map((s) => s / 2) as Vec3
      const o = b.shape.offset ?? [0, 0, 0]
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
        grow(xpoint(w, [o[0] + sx * h[0], o[1] + sy * h[1], o[2] + sz * h[2]]))
    } else {
      grow(w.p)
      grow(world.joint[b.name].p)
    }
  }
  if (!isFinite(min[0])) return { min: [-1, 0, -1], max: [1, 2, 1] }
  return { min, max }
}

export function rigHeight(rig: Rig): number {
  const b = rigBounds(rig, restWorld(rig))
  return Math.max(1e-3, b.max[1] - b.min[1])
}

/** Left<->Right partner of a bone or chain name, or the name itself when it has no side. */
export function mirrorName(name: string): string {
  const swaps: [RegExp, string][] = [
    [/Left/g, '\u0000R\u0000'], [/Right/g, 'Left'], [/\u0000R\u0000/g, 'Right'],
    [/left/g, '\u0000r\u0000'], [/right/g, 'left'], [/\u0000r\u0000/g, 'right']
  ]
  let out = name
  for (const [re, to] of swaps) out = out.replace(re, to)
  if (out !== name) return out
  // Suffix / prefix styles: Arm.L, Arm_L, L_Arm, mixamorig:LeftArm handled above.
  const m = name.match(/^(.*[._\- ])([LR])$/) ?? null
  if (m) return m[1] + (m[2] === 'L' ? 'R' : 'L')
  const p = name.match(/^([LR])([._\- ].*)$/)
  if (p) return (p[1] === 'L' ? 'R' : 'L') + p[2]
  return name
}

/** Mirror a local rotation/position across the rig's YZ plane (X -> -X). */
export const mirrorQuat = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]]
export const mirrorVec = (v: Vec3): Vec3 => [-v[0], v[1], v[2]]

export function composeLocal(b: BoneDef, t: Xform): Xform {
  return xmul(xmul(b.pre, t), b.post)
}

export const rotateBy = (q: Quat, v: Vec3): Vec3 => qrot(q, v)
export const qcompose = (...qs: Quat[]): Quat => qnorm(qs.reduce((a, b) => qmul(a, b), qid()))
export const offsetPoint = (x: Xform, p: Vec3): Vec3 => vadd(x.p, qrot(x.q, p))
