// Roblox KeyframeSequence <-> .rbxmx (Roblox XML model).
//
// Format facts (verified against the rbx-dom XML spec, Roblox creator docs and Studio-saved files):
// - <roblox version="4"> root; <Item class referent> with one <Properties> then child Items.
// - KeyframeSequence > Keyframe (Time in seconds) > root Pose > nested Poses following the
//   Part0 -> Part1 hierarchy; KeyframeMarkers are children of the Keyframe.
// - Pose.Name is the driven part (Part1) or Bone name. Pose.CFrame is Motor6D.Transform:
//   Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse().
// - CoordinateFrame children: X Y Z R00 R01 R02 R10 R11 R12 R20 R21 R22 (row, column).
// - A pose's easing applies from that pose to the next keyframe's pose.
// - Weight 1 = animated, Weight 0 = placeholder ancestor (the Animation Editor's convention).
// - PoseEasingStyle: Linear 0, Constant 1, Elastic 2, Cubic 3 (deprecated; In/Out reversed at
//   runtime), Bounce 4, CubicV2 5 (In/Out match TweenService). We always write CubicV2.
import { evaluateRig, keyIndexAt, createClip, upsertKey } from '../clip'
import { qFromMat3, qToMat3, type Mat3, type Quat, type Vec3 } from '../math'
import { boneMap } from '../rig'
import type { Clip, EaseDir, EaseStyle, Key, Priority, Rig } from '../types'

export const PRIORITY_VALUES: Record<Priority, number> = { Idle: 0, Movement: 1, Action: 2, Action2: 3, Action3: 4, Action4: 5, Core: 1000 }
const STYLE = { Linear: 0, Constant: 1, Elastic: 2, Cubic: 3, Bounce: 4, CubicV2: 5 }
const DIR = { In: 0, Out: 1, InOut: 2 }

export interface SeqPose {
  name: string
  /** x, y, z, R00..R22 */
  cframe: number[]
  weight: number
  easingStyle: number
  easingDirection: number
  children: SeqPose[]
}
export interface SeqKeyframe {
  name: string
  time: number
  poses: SeqPose[]
  markers: { name: string; value: string }[]
}
export interface Sequence {
  name: string
  loop: boolean
  priority: number
  authoredHipHeight?: number
  keyframes: SeqKeyframe[]
}

// ---------------------------------------------------------------- clip -> sequence

interface ExportKey {
  style: number
  dir: number
}

/**
 * Convert a clip to a KeyframeSequence. Values always come from the fully evaluated pose
 * (contacts and IK tracks included). Linear and cubic segments keep their sparse keys;
 * anything Roblox cannot reproduce exactly is baked: constrained ranges and elastic/bounce
 * segments get a key every frame, and stepped segments get a hold key one frame before the next key.
 */
export function clipToSequence(clip: Clip, rig: Rig): Sequence {
  const tracks = clip.tracks[rig.id] ?? {}
  const bones = boneMap(rig)
  const perBone = new Map<string, Map<number, ExportKey>>()
  const setKey = (bone: string, frame: number, k: ExportKey): void => {
    if (frame < 0 || frame > clip.length) return
    let m = perBone.get(bone)
    if (!m) perBone.set(bone, (m = new Map()))
    m.set(frame, k)
  }
  const linear: ExportKey = { style: STYLE.Linear, dir: DIR.In }
  const dirOf = (d: EaseDir): number => (d === 'in' ? DIR.In : d === 'out' ? DIR.Out : DIR.InOut)

  for (const name in tracks) {
    if (!bones.has(name) || bones.get(name)!.locked) continue
    const keys = tracks[name]
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], next = keys[i + 1]
      if (!next || k.ease === 'linear') setKey(name, k.frame, linear)
      else if (k.ease === 'cubic') setKey(name, k.frame, { style: STYLE.CubicV2, dir: dirOf(k.dir) })
      else if (k.ease === 'constant') {
        setKey(name, k.frame, linear)
        if (next.frame - 1 > k.frame) setKey(name, next.frame - 1, linear)
      } else {
        for (let f = k.frame; f < next.frame; f++) setKey(name, f, linear)
      }
    }
  }
  // Constrained spans: every frame, for the bones of the affected chain.
  const dense = (chainName: string, start: number, end: number): void => {
    const chain = rig.chains.find((c) => c.name === chainName)
    if (!chain) return
    for (const b of chain.bones) for (let f = start - 1; f <= end + 1; f++) setKey(b, f, linear)
  }
  for (const c of clip.contacts) if (c.rig === rig.id) dense(c.chain, c.start, c.end)
  const ik = clip.ikTracks[rig.id] ?? {}
  for (const ch in ik) if (ik[ch].length > 1) dense(ch, ik[ch][0].frame, ik[ch][ik[ch].length - 1].frame)
  // An eased segment that a baked range cuts into cannot keep its curve shape, so bake all of it.
  for (const name in tracks) {
    const m = perBone.get(name)
    if (!m) continue
    const keys = tracks[name]
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i], next = keys[i + 1]
      if (k.ease !== 'cubic') continue
      let cut = false
      for (let f = k.frame + 1; f < next.frame && !cut; f++) cut = m.has(f)
      if (cut) for (let f = k.frame; f < next.frame; f++) m.set(f, linear)
    }
  }
  // Give every animated bone a key on the first and last frame so the sequence has the clip's full length.
  for (const [name, m] of perBone) {
    if (!m.has(0)) m.set(0, linear)
    if (!m.has(clip.length)) m.set(clip.length, linear)
    void name
  }

  const frames = new Set<number>([0, clip.length])
  for (const [, m] of perBone) for (const f of m.keys()) frames.add(f)
  for (const mk of clip.markers) if (mk.frame <= clip.length) frames.add(mk.frame)

  const childrenOf = new Map<string | null, string[]>()
  for (const b of rig.bones) {
    const list = childrenOf.get(b.parent) ?? []
    list.push(b.name)
    childrenOf.set(b.parent, list)
  }

  const keyframes: SeqKeyframe[] = []
  for (const frame of [...frames].sort((a, b) => a - b)) {
    const pose = evaluateRig(clip, rig, frame)
    const build = (name: string): SeqPose | null => {
      const kids = (childrenOf.get(name) ?? []).map(build).filter((x): x is SeqPose => !!x)
      const own = perBone.get(name)?.get(frame)
      const isRoot = name === rig.root
      if (!own && !kids.length && !isRoot) return null
      const t = pose[name]
      const q: Quat = t?.q ?? [0, 0, 0, 1]
      const p: Vec3 = t?.p ?? [0, 0, 0]
      return {
        name, cframe: [p[0], p[1], p[2], ...qToMat3(q)], weight: own ? 1 : 0,
        easingStyle: own?.style ?? STYLE.Linear, easingDirection: own?.dir ?? DIR.In, children: kids
      }
    }
    const root = build(rig.root)
    keyframes.push({
      name: 'Keyframe', time: frame / clip.fps, poses: root ? [root] : [],
      markers: clip.markers.filter((m) => m.frame === frame).map((m) => ({ name: m.name, value: m.value ?? '' }))
    })
  }
  const hip = rig.source === 'r15' ? 2 : typeof rig.meta?.hipHeight === 'number' ? (rig.meta.hipHeight as number) : undefined
  return { name: clip.name, loop: clip.loop, priority: PRIORITY_VALUES[clip.priority] ?? 2, authoredHipHeight: hip, keyframes }
}

// ---------------------------------------------------------------- sequence -> xml

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number): string => {
  if (Object.is(n, -0)) return '0'
  const r = Math.abs(n) < 1e-9 ? 0 : n
  return String(Number(r.toPrecision(9)))
}

export function writeRbxmx(seq: Sequence): string {
  let ref = 0
  const out: string[] = []
  const nextRef = (): string => `RBX${(ref++).toString(16).toUpperCase().padStart(8, '0')}`
  const pad = (n: number): string => '\t'.repeat(n)
  const writePose = (p: SeqPose, d: number): void => {
    const c = p.cframe
    const tags = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']
    out.push(`${pad(d)}<Item class="Pose" referent="${nextRef()}">`)
    out.push(`${pad(d + 1)}<Properties>`)
    out.push(`${pad(d + 2)}<CoordinateFrame name="CFrame">`)
    tags.forEach((t, i) => out.push(`${pad(d + 3)}<${t}>${num(c[i])}</${t}>`))
    out.push(`${pad(d + 2)}</CoordinateFrame>`)
    out.push(`${pad(d + 2)}<token name="EasingDirection">${p.easingDirection}</token>`)
    out.push(`${pad(d + 2)}<token name="EasingStyle">${p.easingStyle}</token>`)
    out.push(`${pad(d + 2)}<string name="Name">${esc(p.name)}</string>`)
    out.push(`${pad(d + 2)}<float name="Weight">${num(p.weight)}</float>`)
    out.push(`${pad(d + 1)}</Properties>`)
    for (const ch of p.children) writePose(ch, d + 1)
    out.push(`${pad(d)}</Item>`)
  }
  out.push('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">')
  out.push('\t<Meta name="ExplicitAutoJoints">true</Meta>')
  out.push('\t<External>null</External>')
  out.push('\t<External>nil</External>')
  out.push(`\t<Item class="KeyframeSequence" referent="${nextRef()}">`)
  out.push('\t\t<Properties>')
  if (seq.authoredHipHeight !== undefined) out.push(`\t\t\t<float name="AuthoredHipHeight">${num(seq.authoredHipHeight)}</float>`)
  out.push(`\t\t\t<bool name="Loop">${seq.loop ? 'true' : 'false'}</bool>`)
  out.push(`\t\t\t<string name="Name">${esc(seq.name)}</string>`)
  out.push(`\t\t\t<token name="Priority">${seq.priority}</token>`)
  out.push('\t\t</Properties>')
  for (const kf of seq.keyframes) {
    out.push(`\t\t<Item class="Keyframe" referent="${nextRef()}">`)
    out.push('\t\t\t<Properties>')
    out.push(`\t\t\t\t<string name="Name">${esc(kf.name)}</string>`)
    out.push(`\t\t\t\t<float name="Time">${num(kf.time)}</float>`)
    out.push('\t\t\t</Properties>')
    for (const p of kf.poses) writePose(p, 3)
    for (const m of kf.markers) {
      out.push(`\t\t\t<Item class="KeyframeMarker" referent="${nextRef()}">`)
      out.push('\t\t\t\t<Properties>')
      out.push(`\t\t\t\t\t<string name="Name">${esc(m.name)}</string>`)
      out.push(`\t\t\t\t\t<string name="Value">${esc(m.value)}</string>`)
      out.push('\t\t\t\t</Properties>')
      out.push('\t\t\t</Item>')
    }
    out.push('\t\t</Item>')
  }
  out.push('\t</Item>')
  out.push('</roblox>')
  return out.join('\n') + '\n'
}

export const exportRbxmx = (clip: Clip, rig: Rig): string => {
  if (rig.source === 'gltf') throw new Error(`"${rig.name}" is a glTF rig; Roblox export needs a Roblox rig (R15, a rig imported from Studio, or a prop). Use format "glb" instead.`)
  return writeRbxmx(clipToSequence(clip, rig))
}

// ---------------------------------------------------------------- xml -> sequence

interface XNode {
  tag: string
  attrs: Record<string, string>
  children: XNode[]
  text: string
}

const unesc = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')

/** Minimal XML reader: elements, attributes, text and CDATA. No DTDs or entities beyond the built-in five. */
export function parseXml(xml: string): XNode {
  const root: XNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XNode[] = [root]
  let i = 0
  const n = xml.length
  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) stack[stack.length - 1].text += unesc(xml.slice(i, lt))
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt)
      i = e < 0 ? n : e + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt)
      stack[stack.length - 1].text += xml.slice(lt + 9, e < 0 ? n : e)
      i = e < 0 ? n : e + 3
      continue
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt)
      i = e < 0 ? n : e + 1
      continue
    }
    const gt = xml.indexOf('>', lt)
    if (gt < 0) throw new Error('Malformed XML: unclosed tag.')
    const body = xml.slice(lt + 1, gt)
    if (body[0] === '/') {
      const tag = body.slice(1).trim()
      const top = stack.pop()
      if (!top || top.tag !== tag || !stack.length) throw new Error(`Malformed XML: unexpected </${tag}>.`)
    } else {
      const selfClose = body.endsWith('/')
      const inner = selfClose ? body.slice(0, -1) : body
      const m = inner.match(/^([^\s]+)/)
      if (!m) throw new Error('Malformed XML: empty tag.')
      const node: XNode = { tag: m[1], attrs: {}, children: [], text: '' }
      const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
      let a: RegExpExecArray | null
      while ((a = re.exec(inner.slice(m[1].length)))) node.attrs[a[1]] = unesc(a[2] ?? a[3] ?? '')
      stack[stack.length - 1].children.push(node)
      if (!selfClose) stack.push(node)
    }
    i = gt + 1
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: <${stack[stack.length - 1].tag}> is not closed.`)
  return root
}

function props(item: XNode): Record<string, XNode> {
  const out: Record<string, XNode> = {}
  const p = item.children.find((c) => c.tag === 'Properties')
  for (const c of p?.children ?? []) if (c.attrs.name) out[c.attrs.name] = c
  return out
}
const items = (n: XNode, cls?: string): XNode[] => n.children.filter((c) => c.tag === 'Item' && (!cls || c.attrs.class === cls))

function readPose(item: XNode): SeqPose {
  const p = props(item)
  const cf = p.CFrame
  const tags = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']
  const cframe = cf
    ? tags.map((t) => Number(cf.children.find((c) => c.tag === t)?.text ?? (t.startsWith('R') && t[1] === t[2] ? 1 : 0)))
    : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  return {
    name: p.Name?.text ?? 'Pose', cframe,
    weight: p.Weight ? Number(p.Weight.text) : 1,
    easingStyle: p.EasingStyle ? Number(p.EasingStyle.text) : 0,
    easingDirection: p.EasingDirection ? Number(p.EasingDirection.text) : 0,
    children: items(item, 'Pose').map(readPose)
  }
}

/** Read the first KeyframeSequence in an .rbxmx file. Keyframes are returned sorted by time. */
export function parseRbxmx(xml: string): Sequence {
  const doc = parseXml(xml)
  const rootEl = doc.children.find((c) => c.tag === 'roblox')
  if (!rootEl) throw new Error('Not a Roblox XML file (no <roblox> root).')
  const find = (n: XNode): XNode | undefined => {
    for (const it of items(n)) {
      if (it.attrs.class === 'KeyframeSequence') return it
      const deep = find(it)
      if (deep) return deep
    }
    return undefined
  }
  const seqEl = find(rootEl)
  if (!seqEl) throw new Error('No KeyframeSequence found in this file.')
  const sp = props(seqEl)
  const keyframes = items(seqEl, 'Keyframe').map((kf) => {
    const kp = props(kf)
    return {
      name: kp.Name?.text ?? 'Keyframe', time: Number(kp.Time?.text ?? 0),
      poses: items(kf, 'Pose').map(readPose),
      markers: items(kf, 'KeyframeMarker').map((m) => {
        const mp = props(m)
        return { name: mp.Name?.text ?? '', value: mp.Value?.text ?? '' }
      })
    }
  }).sort((a, b) => a.time - b.time)
  return {
    name: sp.Name?.text ?? 'KeyframeSequence',
    loop: sp.Loop ? sp.Loop.text.trim() === 'true' : true,
    priority: sp.Priority ? Number(sp.Priority.text) : 2,
    authoredHipHeight: sp.AuthoredHipHeight ? Number(sp.AuthoredHipHeight.text) : undefined,
    keyframes
  }
}

// ---------------------------------------------------------------- sequence -> clip

/** Import a KeyframeSequence as a clip for a rig. Poses for parts the rig does not have are skipped and reported. */
export function sequenceToClip(seq: Sequence, rig: Rig, fps = 30): { clip: Clip; skipped: string[] } {
  const last = seq.keyframes.length ? seq.keyframes[seq.keyframes.length - 1].time : 0
  const clip = createClip(seq.name, Math.max(1, Math.round(last * fps)), fps, seq.loop)
  clip.priority = (Object.entries(PRIORITY_VALUES).find(([, v]) => v === seq.priority)?.[0] as Priority) ?? 'Action'
  const bones = boneMap(rig)
  const skipped = new Set<string>()
  const tracks: Record<string, Key[]> = (clip.tracks[rig.id] = {})
  for (const kf of seq.keyframes) {
    const frame = Math.round(kf.time * fps)
    const visit = (p: SeqPose): void => {
      const b = bones.get(p.name)
      if (!b) skipped.add(p.name)
      else if (p.weight > 0 && !b.locked) {
        let ease: EaseStyle = 'linear'
        let dir: EaseDir = p.easingDirection === 1 ? 'out' : p.easingDirection === 2 ? 'inout' : 'in'
        if (p.easingStyle === 1) ease = 'constant'
        else if (p.easingStyle === 2) ease = 'elastic'
        else if (p.easingStyle === 4) ease = 'bounce'
        else if (p.easingStyle === 5) ease = 'cubic'
        else if (p.easingStyle === 3) {
          // Legacy Cubic plays with In and Out swapped at runtime.
          ease = 'cubic'
          dir = dir === 'in' ? 'out' : dir === 'out' ? 'in' : 'inout'
        }
        const c = p.cframe
        const key: Key = { frame, q: qFromMat3(c.slice(3) as Mat3), ease, dir }
        if (b.translatable && (Math.abs(c[0]) > 1e-9 || Math.abs(c[1]) > 1e-9 || Math.abs(c[2]) > 1e-9 || (tracks[b.name] ?? []).some((k) => k.p))) key.p = [c[0], c[1], c[2]]
        upsertKey((tracks[b.name] ??= []), key)
      }
      p.children.forEach(visit)
    }
    kf.poses.forEach(visit)
    for (const m of kf.markers) clip.markers.push({ name: m.name, frame, ...(m.value ? { value: m.value } : {}) })
  }
  // Translatable tracks need a position on every key once any key has one.
  for (const name in tracks) if (tracks[name].some((k) => k.p)) for (const k of tracks[name]) k.p ??= [0, 0, 0]
  void keyIndexAt
  return { clip, skipped: [...skipped] }
}
