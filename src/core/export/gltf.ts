import { evaluateRig, isConstrainedFrame } from '../clip'
import { BinWriter, buildGlb, parseGlb, readFloats, type Gltf, type GltfNode } from '../gltfIO'
import type { GltfNodeInfo } from '../import/gltf'
import { qmul, qnorm, qrot, vadd, vscale, xmul, type Quat, type Vec3 } from '../math'
import { orderedBones } from '../rig'
import type { Clip, Pose, Rig } from '../types'

// glTF export with the animation baked to one linear key per frame.
//
// Rigs that came from a GLB are written back into that file (mesh, skin and materials kept; its
// old animations replaced). Other rigs are generated: one node per bone at the joint pivot,
// named after the bone, with a child "<bone>_geo" box mesh. Values are in the rig's own units
// (studs for Roblox rigs; glTF nominally uses meters, so scale on import if you need to).

/** Bones worth an animation channel: anything keyed, or driven by a contact / IK track. */
function animatedBones(clip: Clip, rig: Rig): Set<string> {
  const out = new Set<string>(Object.keys(clip.tracks[rig.id] ?? {}))
  const addChain = (name: string): void => rig.chains.find((c) => c.name === name)?.bones.forEach((b) => out.add(b))
  for (const c of clip.contacts) if (c.rig === rig.id) addChain(c.chain)
  for (const ch in clip.ikTracks[rig.id] ?? {}) addChain(ch)
  for (const b of rig.bones) if (b.locked) out.delete(b.name)
  return out
}

function unitCube(w: BinWriter): { position: number; normal: number; indices: number } {
  const pos: number[] = [], nor: number[] = [], idx: number[] = []
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]
  ]
  for (const [n, u, v] of faces) {
    const base = pos.length / 3
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push((n[0] + a * u[0] + b * v[0]) / 2, (n[1] + a * u[1] + b * v[1]) / 2, (n[2] + a * u[2] + b * v[2]) / 2)
      nor.push(...n)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return { position: w.floats(pos, 'VEC3', true, 34962), normal: w.floats(nor, 'VEC3', false, 34962), indices: w.indices(idx) }
}

function writeAnimation(
  json: Gltf, w: BinWriter, clip: Clip, rig: Rig,
  nodeFor: (bone: string) => number | undefined,
  local: (bone: string, pose: Pose) => { r: Quat; t: Vec3 }
): void {
  const bones = [...animatedBones(clip, rig)].filter((b) => nodeFor(b) !== undefined)
  if (!bones.length) return
  const times: number[] = []
  const rot: Record<string, number[]> = {}, tr: Record<string, number[]> = {}
  const movesAtRest: Record<string, Vec3> = {}
  const translates = new Set<string>()
  for (const b of bones) {
    rot[b] = []
    tr[b] = []
    movesAtRest[b] = local(b, {}).t
  }
  for (let f = 0; f <= clip.length; f++) {
    times.push(f / clip.fps)
    const pose = evaluateRig(clip, rig, f)
    for (const b of bones) {
      const l = local(b, pose)
      const prev = rot[b].slice(-4)
      // Keep quaternion sign continuous so linear interpolation takes the short way.
      const flip = prev.length === 4 && prev[0] * l.r[0] + prev[1] * l.r[1] + prev[2] * l.r[2] + prev[3] * l.r[3] < 0
      rot[b].push(...(flip ? l.r.map((x) => -x) : l.r))
      tr[b].push(...l.t)
      const r0 = movesAtRest[b]
      if (Math.abs(l.t[0] - r0[0]) + Math.abs(l.t[1] - r0[1]) + Math.abs(l.t[2] - r0[2]) > 1e-6) translates.add(b)
    }
  }
  const input = w.floats(times, 'SCALAR', true)
  const anim = { name: clip.name, channels: [] as { sampler: number; target: { node: number; path: string } }[], samplers: [] as { input: number; output: number; interpolation: string }[] }
  for (const b of bones) {
    const node = nodeFor(b)!
    anim.samplers.push({ input, output: w.floats(rot[b], 'VEC4'), interpolation: 'LINEAR' })
    anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path: 'rotation' } })
    if (translates.has(b)) {
      anim.samplers.push({ input, output: w.floats(tr[b], 'VEC3'), interpolation: 'LINEAR' })
      anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path: 'translation' } })
    }
  }
  json.animations = [anim]
  void isConstrainedFrame
}

function exportGenerated(clip: Clip, rig: Rig): Uint8Array {
  const json: Gltf = { asset: { version: '2.0', generator: 'Inbetween' }, scene: 0, scenes: [{ name: rig.name, nodes: [0] }], nodes: [], meshes: [], materials: [] }
  const w = new BinWriter(json)
  const cube = unitCube(w)
  json.materials = [{ name: 'Body', pbrMetallicRoughness: { baseColorFactor: [0.78, 0.78, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.7 } }]
  json.meshes = [{ name: 'Box', primitives: [{ attributes: { POSITION: cube.position, NORMAL: cube.normal }, indices: cube.indices, material: 0 }] }]
  const nodes = json.nodes!
  nodes.push({ name: rig.name, translation: [...rig.origin.p], rotation: [...rig.origin.q], children: [] })
  const index = new Map<string, number>()
  const byName = new Map(rig.bones.map((b) => [b.name, b]))
  // Joint node local transform: parent's post offset, then this bone's pre, then the animated T.
  const local = (bone: string, pose: Pose): { r: Quat; t: Vec3 } => {
    const b = byName.get(bone)!
    const parentPost = b.parent ? byName.get(b.parent)!.post : { p: [0, 0, 0] as Vec3, q: [0, 0, 0, 1] as Quat }
    const t = pose[bone]
    const x = xmul(xmul(parentPost, b.pre), { p: t?.p ?? [0, 0, 0], q: t?.q ?? [0, 0, 0, 1] })
    return { r: x.q, t: x.p }
  }
  for (const b of orderedBones(rig)) {
    const l = local(b.name, {})
    const node: GltfNode = { name: b.name, translation: [...l.t], rotation: [...l.r] }
    nodes.push(node)
    const i = nodes.length - 1
    index.set(b.name, i)
    const parent = b.parent ? nodes[index.get(b.parent)!] : nodes[0]
    ;(parent.children ??= []).push(i)
    if (b.shape) {
      const off = b.shape.offset ?? [0, 0, 0]
      nodes.push({ name: `${b.name}_geo`, mesh: 0, translation: vadd(b.post.p, qrot(b.post.q, off)), rotation: [...b.post.q], scale: [...b.shape.size] })
      ;(node.children ??= []).push(nodes.length - 1)
    }
  }
  writeAnimation(json, w, clip, rig, (b) => index.get(b), local)
  const bin = w.finish()
  return buildGlb(json, bin)
}

function exportIntoSource(clip: Clip, rig: Rig, source: Uint8Array): Uint8Array {
  const { json, bin } = parseGlb(source)
  const info = (rig.meta?.gltfNodes ?? {}) as Record<string, GltfNodeInfo>
  delete json.animations
  const w = new BinWriter(json, bin)
  const local = (bone: string, pose: Pose): { r: Quat; t: Vec3 } => {
    const n = info[bone]
    const t = pose[bone]
    const r = t ? qnorm(qmul(n.r, t.q)) : n.r
    const p = t?.p ? vadd(n.t, vscale(qrot(n.r, t.p), 1 / (n.parentScale || 1))) : n.t
    return { r, t: p }
  }
  // Nodes stored as matrices cannot take TRS animation; rewrite the ones we animate as TRS.
  for (const b in info) {
    const node = json.nodes![info[b].index]
    if (node.matrix) {
      delete node.matrix
      node.translation = [...info[b].t]
      node.rotation = [...info[b].r]
    }
  }
  writeAnimation(json, w, clip, rig, (b) => info[b]?.index, local)
  const out = w.finish()
  return buildGlb(json, out)
}

export function exportGlb(clip: Clip, rig: Rig, opts: { source?: Uint8Array } = {}): Uint8Array {
  if (rig.source === 'gltf' && opts.source && rig.meta?.gltfNodes) return exportIntoSource(clip, rig, opts.source)
  if (rig.source === 'gltf' && rig.meta?.gltfNodes && !opts.source) {
    // Source file is gone: still export the skeleton and animation so nothing is lost.
  }
  return exportGenerated(clip, rig)
}

/** Read back the first animation of a GLB: per node name, the sampled rotation/translation arrays. Used by tests and import checks. */
export function readGlbAnimation(bytes: Uint8Array): { name?: string; times: number[]; nodes: Record<string, { rotation?: number[]; translation?: number[] }>; rest: Record<string, { t: number[]; r: number[] }> } {
  const { json, bin } = parseGlb(bytes)
  const rest: Record<string, { t: number[]; r: number[] }> = {}
  for (const n of json.nodes ?? []) if (n.name) rest[n.name] = { t: n.translation ?? [0, 0, 0], r: n.rotation ?? [0, 0, 0, 1] }
  const anim = json.animations?.[0]
  if (!anim) return { times: [], nodes: {}, rest }
  const nodes: Record<string, { rotation?: number[]; translation?: number[] }> = {}
  let times: number[] = []
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler]
    times = readFloats(json, bin, s.input)
    const name = json.nodes![ch.target.node!].name ?? `node_${ch.target.node}`
    const entry = (nodes[name] ??= {})
    if (ch.target.path === 'rotation') entry.rotation = readFloats(json, bin, s.output)
    else if (ch.target.path === 'translation') entry.translation = readFloats(json, bin, s.output)
  }
  return { name: anim.name, times, nodes, rest }
}
