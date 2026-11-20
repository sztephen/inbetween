import { qFromEulerDeg, qid, vsub, type Vec3 } from './math'
import type { BoneDef, Rig } from './types'

/** A prop is a simple rig: boxes joined by pivots. */
export interface PropPart {
  name: string
  parent?: string | null
  /** Box size [x, y, z]. */
  size: Vec3
  /** Box centre at rest, in the parent part's frame (scene space for the root part). */
  position: Vec3
  /** Pivot the part rotates about, in the same frame as `position`. Defaults to the centre. */
  pivot?: Vec3
  /** Rest rotation of the pivot frame, Euler XYZ degrees. */
  rotation?: Vec3
  /** Rotation limits in degrees, Euler XYZ. */
  limits?: { min: Vec3; max: Vec3 }
  /** Allow position keys (sliding parts). Root parts are always translatable. */
  translatable?: boolean
}

export function createProp(id: string, name: string, parts: PropPart[], units: Rig['units'] = 'studs'): Rig {
  if (!parts.length) throw new Error('A prop needs at least one part.')
  const names = new Set<string>()
  const bones: BoneDef[] = parts.map((p) => {
    if (names.has(p.name)) throw new Error(`Duplicate part name "${p.name}".`)
    names.add(p.name)
    const pivot = p.pivot ?? p.position
    return {
      name: p.name,
      parent: p.parent ?? null,
      pre: { p: [...pivot] as Vec3, q: p.rotation ? qFromEulerDeg(p.rotation) : qid() },
      post: { p: vsub(p.position, pivot), q: qid() },
      limits: p.limits,
      translatable: p.translatable ?? !p.parent,
      shape: { size: [...p.size] as Vec3 },
      kind: 'node'
    }
  })
  for (const b of bones) if (b.parent && !names.has(b.parent)) throw new Error(`Part "${b.name}" has unknown parent "${b.parent}".`)
  const roots = bones.filter((b) => !b.parent)
  if (roots.length !== 1) throw new Error('A prop needs exactly one root part (one part with no parent).')
  return {
    id,
    name,
    source: 'prop',
    units,
    bones,
    root: roots[0].name,
    hips: roots[0].name,
    chains: [],
    origin: { p: [0, 0, 0], q: qid() }
  }
}

/** Ready-made props for common object animation. */
export const PROP_PRESETS: Record<string, { description: string; parts: PropPart[] }> = {
  box: {
    description: 'A single 2x2x2 crate resting on the ground.',
    parts: [{ name: 'Box', size: [2, 2, 2], position: [0, 1, 0], pivot: [0, 0, 0] }]
  },
  door: {
    description: 'A door in a frame. Rotate "Door" about Y to swing it on its hinge.',
    parts: [
      { name: 'Frame', size: [4.6, 7.4, 0.4], position: [0, 3.7, 0], pivot: [0, 0, 0] },
      { name: 'Door', parent: 'Frame', size: [4, 7, 0.3], position: [0, -0.2, 0], pivot: [-2, -0.2, 0], limits: { min: [0, -120, 0], max: [0, 120, 0] } }
    ]
  },
  chest: {
    description: 'A chest with a hinged lid. Rotate "Lid" about X (negative opens it).',
    parts: [
      { name: 'Base', size: [3, 1.6, 2], position: [0, 0.8, 0], pivot: [0, 0, 0] },
      { name: 'Lid', parent: 'Base', size: [3, 0.6, 2], position: [0, 1.1, 0], pivot: [0, 0.8, 1], limits: { min: [-110, 0, 0], max: [0, 0, 0] } }
    ]
  },
  lever: {
    description: 'A floor lever. Rotate "Handle" about X to throw it.',
    parts: [
      { name: 'Base', size: [1.2, 0.4, 2], position: [0, 0.2, 0], pivot: [0, 0, 0] },
      { name: 'Handle', parent: 'Base', size: [0.3, 2.4, 0.3], position: [0, 1.4, 0], pivot: [0, 0.2, 0], limits: { min: [-50, 0, 0], max: [50, 0, 0] } }
    ]
  }
}
