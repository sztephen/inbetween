import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClip, evaluateRig, writePoseKeys } from '@core/clip'
import { exportGlb, readGlbAnimation } from '@core/export/gltf'
import { clipToSequence, exportRbxmx, parseRbxmx, parseXml, sequenceToClip, writeRbxmx, type SeqPose } from '@core/export/rbxmx'
import { parseGlb } from '@core/gltfIO'
import { importGlbRig } from '@core/import/gltf'
import { importRobloxRig } from '@core/import/robloxRig'
import { qangle, qFromEulerDeg, qFromMat3, qmul, vdist, xmul, type Mat3, type Quat, type Vec3 } from '@core/math'
import { opAddContact, opSetPose } from '@core/ops'
import { createProp, PROP_PRESETS } from '@core/props'
import { createR15 } from '@core/r15'
import { computeWorld } from '@core/rig'
import type { Clip, Rig } from '@core/types'
import data from '@core/r15_data.json'

const rig = createR15()

/** A clip that exercises everything the exporters must carry: easing styles, hips translation, a contact, a marker. */
function sampleClip(): Clip {
  const c = createClip('Punch & "Step"', 24, 30, true)
  c.priority = 'Action2'
  opSetPose({ clip: c, rig, frame: 0, spec: { hips: { position: [0, -0.2, 0] } }, easing: { ease: 'cubic', dir: 'in' } })
  opSetPose({ clip: c, rig, frame: 8, spec: { hips: { position: [0.1, -0.5, 0.2], rotation: [0, 30, 0] }, goals: { right_hand: { position: [1.3, 3.2, 0.6] } }, lookAt: [2, 4, -4] }, easing: { ease: 'cubic', dir: 'out' } })
  opSetPose({ clip: c, rig, frame: 12, spec: { hips: { position: [0, -0.3, -0.2], rotation: [0, -25, 0] }, goals: { right_hand: { position: [0.6, 3.9, -1.9] } } }, easing: { ease: 'constant', dir: 'inout' } })
  opSetPose({ clip: c, rig, frame: 18, spec: { bones: { UpperTorso: { rotation: [10, 0, 5] } } }, easing: { ease: 'elastic', dir: 'out' } })
  opSetPose({ clip: c, rig, frame: 24, from: undefined, spec: { hips: { position: [0, -0.2, 0], rotation: [0, 0, 0] } }, base: evaluateRig(c, rig, 0) })
  opAddContact(c, rig, 'left_foot', 3, 20)
  c.markers.push({ name: 'hit', frame: 12, value: 'heavy' })
  return c
}

describe('Roblox .rbxmx export', () => {
  it('round-trips a clip: export -> parse -> import plays the same motion on every frame', () => {
    const clip = sampleClip()
    const xml = exportRbxmx(clip, rig)
    const seq = parseRbxmx(xml)
    expect(seq.name).toBe('Punch & "Step"')
    expect(seq.loop).toBe(true)
    expect(seq.priority).toBe(3)
    expect(seq.authoredHipHeight).toBe(2)
    expect(seq.keyframes[seq.keyframes.length - 1].time).toBeCloseTo(24 / 30, 6)
    const { clip: back, skipped } = sequenceToClip(seq, rig, 30)
    expect(skipped).toEqual([])
    expect(back.markers).toEqual([{ name: 'hit', frame: 12, value: 'heavy' }])
    expect(back.length).toBe(24)
    for (let f = 0; f <= 24; f++) {
      const a = computeWorld(rig, evaluateRig(clip, rig, f)), b = computeWorld(rig, evaluateRig(back, rig, f))
      for (const bone of rig.bones) {
        expect(vdist(a.bone[bone.name].p, b.bone[bone.name].p), `${bone.name} position @${f}`).toBeLessThan(2e-3)
        expect(qangle(a.bone[bone.name].q, b.bone[bone.name].q), `${bone.name} rotation @${f}`).toBeLessThan(2e-3)
      }
    }
  })

  it('writes the documented structure and the Motor6D.Transform convention', () => {
    const clip = createClip('one', 10, 30, false)
    opSetPose({ clip, rig, frame: 0, spec: {} })
    opSetPose({ clip, rig, frame: 10, spec: { bones: { RightUpperArm: { rotation: [90, 0, 0] } }, hips: { position: [0, 1, 0] }, keepFeet: false }, easing: { ease: 'cubic', dir: 'out' } })
    const xml = exportRbxmx(clip, rig)
    const doc = parseXml(xml)
    const root = doc.children.find((c) => c.tag === 'roblox')!
    expect(root.attrs.version).toBe('4')
    const refs = [...xml.matchAll(/referent="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(refs).size).toBe(refs.length)
    const seq = parseRbxmx(xml)
    expect(seq.loop).toBe(false)
    expect(seq.priority).toBe(2)
    const last = seq.keyframes[seq.keyframes.length - 1]
    // Pose tree follows Part0 -> Part1 from the root part; the root is a weight-0 placeholder.
    const rootPose = last.poses[0]
    expect(rootPose.name).toBe('HumanoidRootPart')
    expect(rootPose.weight).toBe(0)
    const find = (p: SeqPose, name: string, path: string[] = []): { pose: SeqPose; path: string[] } | undefined => {
      if (p.name === name) return { pose: p, path }
      for (const c of p.children) {
        const r = find(c, name, [...path, p.name])
        if (r) return r
      }
      return undefined
    }
    const arm = find(rootPose, 'RightUpperArm')!
    expect(arm.path).toEqual(['HumanoidRootPart', 'LowerTorso', 'UpperTorso'])
    expect(arm.pose.weight).toBe(1)
    // CFrame is the joint transform: applying Part0 * C0 * Transform * C1^-1 with the real R15
    // C0/C1 reproduces the part positions Inbetween shows.
    const tf = (p: SeqPose) => ({ p: p.cframe.slice(0, 3) as Vec3, q: qFromMat3(p.cframe.slice(3) as Mat3) })
    const joints = Object.fromEntries(data.joints.map((j) => [j.part1, j]))
    let world = { p: [0, 3, 0] as Vec3, q: [0, 0, 0, 1] as Quat }
    for (const name of ['LowerTorso', 'UpperTorso', 'RightUpperArm']) {
      const j = joints[name]
      const pose = find(rootPose, name)!.pose
      world = xmul(xmul(xmul(world, { p: j.c0 as Vec3, q: [0, 0, 0, 1] }), tf(pose)), { p: (j.c1 as number[]).map((x) => -x) as Vec3, q: [0, 0, 0, 1] })
    }
    const expected = computeWorld(rig, evaluateRig(clip, rig, 10)).bone.RightUpperArm
    expect(vdist(world.p, expected.p)).toBeLessThan(1e-4)
    expect(qangle(world.q, expected.q)).toBeLessThan(1e-4)
    // Hips translation is carried in the LowerTorso pose; first key uses CubicV2 (5), never legacy Cubic (3).
    expect(find(rootPose, 'LowerTorso')!.pose.cframe[1]).toBeCloseTo(1, 5)
    expect(xml).not.toMatch(/<token name="EasingStyle">3<\/token>/)
    const first = find(seq.keyframes[0].poses[0], 'RightUpperArm')!.pose
    expect(first.easingStyle).toBe(0)
  })

  it('cubic keys export as CubicV2 with the same-named direction', () => {
    const clip = createClip('e', 10, 30, false)
    opSetPose({ clip, rig, frame: 0, spec: {}, easing: { ease: 'cubic', dir: 'out' } })
    opSetPose({ clip, rig, frame: 10, spec: { bones: { Head: { rotation: [0, 40, 0] } } } })
    const seq = clipToSequence(clip, rig)
    expect(seq.keyframes).toHaveLength(2)
    const head = JSON.stringify(seq.keyframes[0]).match(/"name":"Head","cframe":\[[^\]]*\],"weight":1,"easingStyle":(\d),"easingDirection":(\d)/)!
    expect([head[1], head[2]]).toEqual(['5', '1'])
  })

  it('reads a real Roblox animation file and re-writes it without loss', () => {
    const xml = readFileSync(join(__dirname, 'fixtures/roform_jump_r6.rbxmx'), 'utf8')
    const seq = parseRbxmx(xml)
    expect(seq.name).toBe('Jump')
    expect(seq.loop).toBe(false)
    expect(seq.priority).toBe(1000)
    expect(seq.keyframes).toHaveLength(6)
    const count = (p: SeqPose): number => 1 + p.children.reduce((n, c) => n + count(c), 0)
    expect(seq.keyframes.reduce((n, k) => n + k.poses.reduce((m, p) => m + count(p), 0), 0)).toBe(42)
    expect(seq.keyframes[0].poses[0].name).toBe('HumanoidRootPart')
    expect(seq.keyframes[0].poses[0].children[0].name).toBe('Torso')
    // Every rotation in the real file is orthonormal once read through our CFrame layout.
    const walk = (p: SeqPose): void => {
      const q = qFromMat3(p.cframe.slice(3) as Mat3)
      expect(Math.hypot(...q)).toBeCloseTo(1, 4)
      p.children.forEach(walk)
    }
    seq.keyframes.forEach((k) => k.poses.forEach(walk))
    const again = parseRbxmx(writeRbxmx(seq))
    expect(again.keyframes.length).toBe(seq.keyframes.length)
    const flat = (s: typeof seq) => JSON.stringify(s, (_k, v) => (typeof v === 'number' ? Number(v.toFixed(5)) : v))
    expect(flat(again)).toBe(flat(seq))
  })

  it('refuses glTF rigs with a clear message', () => {
    const g: Rig = { ...rig, source: 'gltf' }
    expect(() => exportRbxmx(createClip('x'), g)).toThrow(/glTF rig/)
  })
})

describe('glTF export', () => {
  it('round-trips: the baked channels reproduce the evaluated pose on every frame', () => {
    const clip = sampleClip()
    const glb = exportGlb(clip, rig)
    const { json } = parseGlb(glb)
    expect(json.asset.version).toBe('2.0')
    expect(json.nodes!.some((n) => n.name === 'RightUpperArm')).toBe(true)
    expect(json.nodes!.some((n) => n.name === 'RightUpperArm_geo' && n.mesh === 0)).toBe(true)
    const anim = readGlbAnimation(glb)
    expect(anim.name).toBe(clip.name)
    expect(anim.times).toHaveLength(25)
    expect(anim.times[24]).toBeCloseTo(24 / 30, 5)
    // Rebuild world transforms from the file's node hierarchy + channels and compare to the app's FK.
    const parent = new Map<number, number>()
    json.nodes!.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))
    const idx = new Map(json.nodes!.map((n, i) => [n.name!, i]))
    for (let f = 0; f <= 24; f += 3) {
      const local = (i: number) => {
        const n = json.nodes![i]
        const ch = anim.nodes[n.name!]
        return {
          p: (ch?.translation ? ch.translation.slice(f * 3, f * 3 + 3) : n.translation ?? [0, 0, 0]) as Vec3,
          q: (ch?.rotation ? ch.rotation.slice(f * 4, f * 4 + 4) : n.rotation ?? [0, 0, 0, 1]) as Quat
        }
      }
      const world = (i: number): { p: Vec3; q: Quat } => (parent.has(i) ? xmul(world(parent.get(i)!), local(i)) : local(i))
      const want = computeWorld(rig, evaluateRig(clip, rig, f))
      for (const b of rig.bones) {
        if (!b.shape) continue
        const got = world(idx.get(`${b.name}_geo`)!)
        expect(vdist(got.p, want.bone[b.name].p), `${b.name} @${f}`).toBeLessThan(1e-4)
        expect(qangle(got.q, want.bone[b.name].q), `${b.name} rot @${f}`).toBeLessThan(1e-3)
      }
    }
  })

  it('imports its own export as a rig and writes animation back into the source file', () => {
    const base = exportGlb(createClip('rest', 1), rig)
    const imported = importGlbRig(base, 'g1', 'Imported', '/tmp/x.glb')
    expect(imported.source).toBe('gltf')
    expect(imported.bones.some((b) => b.name === 'RightUpperArm')).toBe(true)
    expect(imported.chains.map((c) => c.name).sort()).toEqual(['left_foot', 'left_hand', 'right_foot', 'right_hand'])
    const clip = createClip('nod', 10, 30)
    writePoseKeys(clip, imported, 0, { Head: { q: [0, 0, 0, 1] } })
    writePoseKeys(clip, imported, 10, { Head: { q: qFromEulerDeg([0, 45, 0]) } })
    const out = exportGlb(clip, imported, { source: base })
    const { json } = parseGlb(out)
    expect(json.meshes).toHaveLength(1) // source content kept
    const anim = readGlbAnimation(out)
    expect(Object.keys(anim.nodes)).toEqual(['Head'])
    const lastQ = anim.nodes.Head.rotation!.slice(-4) as Quat
    expect(qangle(lastQ, qmul(anim.rest.Head.r as Quat, qFromEulerDeg([0, 45, 0])))).toBeLessThan(1e-3)
  })

  it('exports props', () => {
    const door = createProp('door', 'Door', PROP_PRESETS.door.parts)
    const clip = createClip('open', 20, 30)
    writePoseKeys(clip, door, 0, { Door: { q: [0, 0, 0, 1] } })
    writePoseKeys(clip, door, 20, { Door: { q: qFromEulerDeg([0, 90, 0]) } })
    const anim = readGlbAnimation(exportGlb(clip, door))
    expect(anim.nodes.Door.rotation).toHaveLength(21 * 4)
    const xml = exportRbxmx(clip, door)
    expect(parseRbxmx(xml).keyframes).toHaveLength(2)
  })
})

describe('custom Roblox rig import', () => {
  it('rebuilds R15 from plugin-style JSON with the same rest pose and chains', () => {
    const rest = computeWorld(rig, {})
    const id = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const json = {
      format: 'inbetween-roblox-rig' as const, version: 1 as const, name: 'Dummy', rootPart: 'HumanoidRootPart',
      parts: rig.bones.map((b) => ({ name: b.name, size: b.shape?.size ?? [2, 2, 1], cframe: [rest.bone[b.name].p[0] + 10, rest.bone[b.name].p[1] + 7, rest.bone[b.name].p[2] - 4, ...id] })),
      joints: data.joints.map((j) => ({ name: j.name, type: 'Motor6D', part0: j.part0, part1: j.part1, c0: [...j.c0, ...id], c1: [...j.c1, ...id] }))
    }
    const imp = importRobloxRig(json, 'custom')
    const w = computeWorld(imp, {})
    for (const b of rig.bones) expect(vdist(w.bone[b.name].p, rest.bone[b.name].p), b.name).toBeLessThan(1e-4)
    expect(imp.hips).toBe('LowerTorso')
    expect(imp.head).toBe('Head')
    expect(imp.chains.map((c) => c.name).sort()).toEqual(['left_foot', 'left_hand', 'right_foot', 'right_hand'])
    expect(imp.bones.find((b) => b.name === 'RightLowerArm')!.limits).toBeDefined()
    expect(() => importRobloxRig({ format: 'nope' } as never, 'x')).toThrow(/Not an Inbetween Roblox rig/)
  })
})
