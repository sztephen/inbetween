import { qFromMat3, qid, xinv, xmul, type Mat3, type Vec3, type Xform } from '../math'
import { autoSetup } from '../rigSetup'
import type { BoneDef, Rig } from '../types'

/** JSON written by the Inbetween Studio plugin's "Send rig" / "Copy rig JSON". CFrames are 12 numbers: x,y,z,R00..R22. */
export interface RobloxRigJson {
  format: 'inbetween-roblox-rig'
  version: 1
  name: string
  rootPart: string
  hipHeight?: number
  parts: { name: string; size: number[]; cframe: number[] }[]
  joints: { name: string; type: string; part0: string; part1: string; c0: number[]; c1: number[] }[]
  bones?: { name: string; parent: string; cframe: number[] }[]
}

const cf = (c: number[]): Xform => ({ p: [c[0], c[1], c[2]], q: qFromMat3(c.slice(3, 12) as Mat3) })

export function importRobloxRig(json: RobloxRigJson, id: string, name?: string): Rig {
  if (!json || json.format !== 'inbetween-roblox-rig') throw new Error('Not an Inbetween Roblox rig file (expected format "inbetween-roblox-rig"). Export it with the Inbetween Studio plugin.')
  if (!Array.isArray(json.parts) || !json.parts.length) throw new Error('The rig file has no parts.')
  const parts = new Map(json.parts.map((p) => [p.name, p]))
  if (parts.size !== json.parts.length) throw new Error('This rig has parts with duplicate names; Roblox animation needs unique part names. Rename them in Studio and export again.')
  const driven = new Set(json.joints.map((j) => j.part1))
  const rootName = parts.has(json.rootPart) && !driven.has(json.rootPart)
    ? json.rootPart
    : json.parts.find((p) => !driven.has(p.name) && json.joints.some((j) => j.part0 === p.name))?.name ?? json.parts[0].name
  const rootPart = parts.get(rootName)!
  const rootWorld = cf(rootPart.cframe)

  // Ground the rig: lowest part bottom at y=0, root part centred on x/z.
  let minY = Infinity
  for (const p of json.parts) minY = Math.min(minY, p.cframe[1] - Math.abs(p.size[1]) / 2)
  const bones: BoneDef[] = [{
    name: rootName, parent: null,
    pre: { p: [0, rootWorld.p[1] - (isFinite(minY) ? minY : 0), 0], q: rootWorld.q },
    post: { p: [0, 0, 0], q: qid() },
    shape: undefined, locked: json.joints.length > 0, translatable: json.joints.length === 0, kind: 'motor6d'
  }]
  const placed = new Set([rootName])
  let progress = true
  while (progress) {
    progress = false
    for (const j of json.joints) {
      if (placed.has(j.part1) || !placed.has(j.part0) || !parts.has(j.part1)) continue
      bones.push({
        name: j.part1, parent: j.part0, pre: cf(j.c0), post: xinv(cf(j.c1)),
        shape: { size: parts.get(j.part1)!.size.map(Math.abs) as Vec3 }, joint: j.name, kind: 'motor6d'
      })
      placed.add(j.part1)
      progress = true
    }
  }
  for (const b of json.bones ?? []) {
    if (placed.has(b.name)) throw new Error(`Bone "${b.name}" shares its name with another part or bone; names must be unique.`)
  }
  progress = true
  const pending = [...(json.bones ?? [])]
  while (progress && pending.length) {
    progress = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const b = pending[i]
      if (!placed.has(b.parent)) continue
      bones.push({ name: b.name, parent: b.parent, pre: cf(b.cframe), post: { p: [0, 0, 0], q: qid() }, joint: 'Bone', kind: 'bone' })
      placed.add(b.name)
      pending.splice(i, 1)
      progress = true
    }
  }
  void xmul
  const rig: Rig = {
    id, name: name ?? json.name ?? 'Roblox rig', source: 'roblox', units: 'studs', bones, root: rootName, hips: rootName, chains: [],
    origin: { p: [0, 0, 0], q: qid() }, meta: { model: json.name, hipHeight: json.hipHeight }
  }
  // A root part with a size is still worth drawing for single-part models.
  if (json.joints.length === 0) bones[0].shape = { size: rootPart.size.map(Math.abs) as Vec3 }
  autoSetup(rig)
  return rig
}
