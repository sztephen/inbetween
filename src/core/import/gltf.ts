import { parseGlb, type GltfNode } from '../gltfIO'
import { qFromAxisAngle, qFromMat3, qid, qmul, qnorm, qrot, vadd, vscale, type Mat3, type Quat, type Vec3 } from '../math'
import { autoSetup } from '../rigSetup'
import type { BoneDef, Rig } from '../types'

interface TRS {
  t: Vec3
  r: Quat
  s: number
}

function nodeTRS(n: GltfNode): TRS {
  if (n.matrix) {
    const m = n.matrix
    const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1
    // glTF matrices are column-major.
    const rot: Mat3 = [m[0] / sx, m[4] / sy, m[8] / sz, m[1] / sx, m[5] / sy, m[9] / sz, m[2] / sx, m[6] / sy, m[10] / sz]
    return { t: [m[12], m[13], m[14]], r: qFromMat3(rot), s: (sx + sy + sz) / 3 }
  }
  const sc = n.scale ?? [1, 1, 1]
  return {
    t: (n.translation ?? [0, 0, 0]) as Vec3,
    r: qnorm((n.rotation ?? [0, 0, 0, 1]) as Quat),
    s: (Math.abs(sc[0]) + Math.abs(sc[1]) + Math.abs(sc[2])) / 3
  }
}

/** Per-bone data needed to write animation back into the source file's node space. */
export interface GltfNodeInfo {
  index: number
  t: Vec3
  r: Quat
  /** World scale of the node's parent: bone-space positions are source positions times this. */
  parentScale: number
}

/**
 * Build a rig from a glTF/GLB skeleton: the first skin's joints, or every node if the file has no skin.
 * glTF models face +Z, so the rig is turned 180 degrees in the scene to face -Z like everything else.
 * Non-uniform node scale is approximated by its average.
 */
export function importGlbRig(bytes: Uint8Array, id: string, name?: string, path?: string): Rig {
  const { json } = parseGlb(bytes)
  const nodes = json.nodes ?? []
  if (!nodes.length) throw new Error('This glTF file has no nodes.')
  const parentOf = new Array<number>(nodes.length).fill(-1)
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parentOf[c] = i)))

  const skin = json.skins?.[0]
  let jointSet: Set<number>
  if (skin?.joints?.length) jointSet = new Set(skin.joints)
  else {
    const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => parentOf[i] < 0)
    jointSet = new Set<number>()
    const walk = (i: number): void => {
      jointSet.add(i)
      ;(nodes[i].children ?? []).forEach(walk)
    }
    sceneNodes.forEach(walk)
  }

  // World transform (rotation, translation, uniform scale) of every node.
  const world: (TRS | undefined)[] = new Array(nodes.length)
  const worldOf = (i: number): TRS => {
    if (world[i]) return world[i]!
    const l = nodeTRS(nodes[i])
    const p = parentOf[i] >= 0 ? worldOf(parentOf[i]) : { t: [0, 0, 0] as Vec3, r: qid(), s: 1 }
    const w = { t: vadd(p.t, qrot(p.r, vscale(l.t, p.s))), r: qnorm(qmul(p.r, l.r)), s: p.s * l.s }
    world[i] = w
    return w
  }

  const names = new Map<number, string>()
  const taken = new Set<string>()
  for (const i of jointSet) {
    let base = (nodes[i].name || `node_${i}`).trim() || `node_${i}`
    let n = base, k = 2
    while (taken.has(n)) n = `${base}_${k++}`
    taken.add(n)
    names.set(i, n)
    void base
  }

  const roots = [...jointSet].filter((i) => !jointSet.has(parentOf[i]))
  const bones: BoneDef[] = []
  const info: Record<string, GltfNodeInfo> = {}
  let rootName: string
  if (roots.length === 1) rootName = names.get(roots[0])!
  else {
    rootName = taken.has('Root') ? '__root' : 'Root'
    bones.push({ name: rootName, parent: null, pre: { p: [0, 0, 0], q: qid() }, post: { p: [0, 0, 0], q: qid() }, locked: true, kind: 'node' })
  }
  const order = [...jointSet].sort((a, b) => depth(a) - depth(b))
  function depth(i: number): number {
    let d = 0
    for (let p = parentOf[i]; p >= 0; p = parentOf[p]) d++
    return d
  }
  for (const i of order) {
    const l = nodeTRS(nodes[i])
    const pi = parentOf[i]
    const isRoot = !jointSet.has(pi)
    const pw = pi >= 0 ? worldOf(pi) : { t: [0, 0, 0] as Vec3, r: qid(), s: 1 }
    const nm = names.get(i)!
    bones.push({
      name: nm,
      parent: isRoot ? (roots.length === 1 ? null : rootName) : names.get(pi)!,
      // Roots fold their non-joint ancestors' transform in; other joints are local to their parent joint.
      pre: isRoot ? { p: vadd(pw.t, qrot(pw.r, vscale(l.t, pw.s))), q: qnorm(qmul(pw.r, l.r)) } : { p: vscale(l.t, pw.s), q: l.r },
      post: { p: [0, 0, 0], q: qid() },
      translatable: isRoot || undefined,
      kind: 'node'
    })
    info[nm] = { index: i, t: l.t, r: l.r, parentScale: pw.s }
  }

  const rig: Rig = {
    id, name: name ?? (path ? path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : 'glTF rig'), source: 'gltf', units: 'meters',
    bones, root: rootName, hips: rootName, chains: [], forward: [0, 0, 1],
    origin: { p: [0, 0, 0], q: qFromAxisAngle([0, 1, 0], Math.PI) },
    mesh: path ? { type: 'glb', path } : undefined,
    meta: { gltfNodes: info, hasSkin: !!skin }
  }
  autoSetup(rig)
  return rig
}
