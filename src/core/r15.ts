import data from './r15_data.json'
import { qid, vneg, type Vec3 } from './math'
import type { BoneDef, IKChainDef, Rig } from './types'

// Built-in Roblox R15 Block Rig. Joint offsets (Motor6D C0/C1) and part sizes come
// verbatim from an exported Rig Builder rig (see r15_data.json "source"); only the
// rotation limits and IK chain hints below are authored for Inbetween.
// Facing: the character looks down -Z, +X is its right, +Y is up. Units are studs.

type Limits = { min: Vec3; max: Vec3 }
const L = (min: Vec3, max: Vec3): Limits => ({ min, max })

/** Limits on Motor6D.Transform, Euler XYZ degrees. +X swings a hanging limb forward. */
export const R15_LIMITS: Record<string, Limits> = {
  UpperTorso: L([-45, -50, -35], [60, 50, 35]),
  Head: L([-50, -80, -35], [50, 80, 35]),
  RightLowerArm: L([0, -90, -2], [150, 90, 2]),
  LeftLowerArm: L([0, -90, -2], [150, 90, 2]),
  RightHand: L([-70, -30, -45], [70, 30, 45]),
  LeftHand: L([-70, -30, -45], [70, 30, 45]),
  RightLowerLeg: L([-150, -2, -2], [0, 2, 2]),
  LeftLowerLeg: L([-150, -2, -2], [0, 2, 2]),
  RightFoot: L([-50, -25, -25], [45, 25, 25]),
  LeftFoot: L([-50, -25, -25], [45, 25, 25])
}

/** Ball joints: swing cone + twist range. Centre directions are in rig space (x is mirrored for the left side). */
const R15_CONES: Record<string, { center: Vec3; angle: number; twist: [number, number] }> = {
  UpperArm: { center: [0.6, -0.3, -0.5], angle: 135, twist: [-90, 90] },
  UpperLeg: { center: [0.15, -0.75, -0.65], angle: 95, twist: [-45, 45] }
}

export function createR15(id = 'r15', name = 'R15'): Rig {
  const parts = data.parts as Record<string, { size: number[] }>
  const bones: BoneDef[] = [
    {
      name: 'HumanoidRootPart',
      parent: null,
      // Root part centre sits HipHeight + half its height above the ground.
      pre: { p: [0, data.hipHeight + parts.HumanoidRootPart.size[1] / 2, 0], q: qid() },
      post: { p: [0, 0, 0], q: qid() },
      locked: true,
      kind: 'motor6d'
    }
  ]
  for (const j of data.joints) {
    bones.push({
      name: j.part1,
      parent: j.part0,
      pre: { p: j.c0 as Vec3, q: qid() },
      post: { p: vneg(j.c1 as Vec3), q: qid() },
      limits: R15_LIMITS[j.part1],
      cone: coneFor(j.part1),
      translatable: j.part1 === 'LowerTorso',
      shape: { size: parts[j.part1].size as Vec3 },
      joint: j.name,
      kind: 'motor6d'
    })
  }
  const footH = parts.RightFoot.size[1]
  const chains: IKChainDef[] = []
  for (const side of ['Right', 'Left'] as const) {
    const sx = side === 'Right' ? 1 : -1
    const lower = side.toLowerCase()
    chains.push({
      name: `${lower}_hand`,
      kind: 'arm',
      bones: [`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`],
      tip: [0, 0, 0],
      restPole: [0, 0, 1],
      defaultPole: [0.5 * sx, -0.6, 0.7]
    })
    chains.push({
      name: `${lower}_foot`,
      kind: 'leg',
      bones: [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`],
      tip: [0, -footH / 2, 0],
      restPole: [0, 0, -1],
      defaultPole: [0, 0.15, -1],
      levelEnd: true
    })
  }
  return {
    id,
    name,
    source: 'r15',
    units: 'studs',
    bones,
    root: 'HumanoidRootPart',
    hips: 'LowerTorso',
    head: 'Head',
    chains,
    origin: { p: [0, 0, 0], q: qid() },
    meta: { body: data.bodyType, dataSource: data.source }
  }
}

function coneFor(part: string): BoneDef['cone'] {
  const m = part.match(/^(Left|Right)(UpperArm|UpperLeg)$/)
  if (!m) return undefined
  const c = R15_CONES[m[2]]
  const sx = m[1] === 'Right' ? 1 : -1
  return { axis: [0, -1, 0], center: [c.center[0] * sx, c.center[1], c.center[2]], angle: c.angle, twist: c.twist }
}
