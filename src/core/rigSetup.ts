import { vcross, vdot, vlen, vnorm, vscale, vsub, xinv, xpoint, type Vec3 } from './math'
import { R15_LIMITS } from './r15'
import { boneMap, computeWorld } from './rig'
import type { BoneDef, IKChainDef, Rig } from './types'

const sideOf = (name: string): 'left' | 'right' | null => {
  if (/left/i.test(name) || /(^|[._\- ])l([._\- ]|$)/i.test(name) || /[a-z]L$/.test(name)) return 'left'
  if (/right/i.test(name) || /(^|[._\- ])r([._\- ]|$)/i.test(name) || /[a-z]R$/.test(name)) return 'right'
  return null
}

/**
 * Detect arm and leg IK chains on an imported rig from bone names (Hand/Foot ends, with their
 * parent and grandparent as the two-bone limb), and pick hips/head bones. Works for Roblox
 * part names, Mixamo, and common Blender naming.
 */
export function autoSetup(rig: Rig): void {
  const bones = boneMap(rig)
  const rest = computeWorld({ ...rig, origin: { p: [0, 0, 0], q: [0, 0, 0, 1] } } as Rig, {})
  const fwd = rig.forward ?? [0, 0, -1]
  const back: Vec3 = [-fwd[0], -fwd[1], -fwd[2]]
  let groundY = Infinity
  for (const b of rig.bones) {
    const half = b.shape ? b.shape.size[1] / 2 : 0
    groundY = Math.min(groundY, rest.bone[b.name].p[1] - half, rest.joint[b.name].p[1])
  }
  const chains: IKChainDef[] = []
  const used = new Set<string>()
  for (const b of rig.bones) {
    const isHand = /hand$/i.test(b.name.replace(/[._\- ]?[lr]$/i, '')) || /hand/i.test(b.name) && !/thumb|index|middle|ring|pinky|finger/i.test(b.name)
    const isFoot = /foot/i.test(b.name) && !/toe/i.test(b.name)
    if (!isHand && !isFoot) continue
    const side = sideOf(b.name)
    const lower = b.parent ? bones.get(b.parent) : undefined
    const upper = lower?.parent ? bones.get(lower.parent) : undefined
    if (!side || !lower || !upper || !upper.parent) continue
    const name = `${side}_${isHand ? 'hand' : 'foot'}`
    if (used.has(name)) continue
    used.add(name)
    const S = rest.joint[upper.name].p, E = rest.joint[lower.name].p, W = rest.joint[b.name].p
    // If the limb is already bent at rest, its bend defines the hinge; otherwise elbows point back, knees forward.
    const dir = vnorm(vsub(W, S))
    const off = vsub(vsub(E, S), vscale(dir, vdot(vsub(E, S), dir)))
    const bent = vlen(off) > 0.04 * (vlen(vsub(E, S)) + vlen(vsub(W, E)))
    let restPole: Vec3 = bent ? vnorm(off) : isHand ? back : fwd
    if (vlen(vcross(restPole, dir)) < 0.2) restPole = isHand ? back : fwd
    if (vlen(vcross(restPole, dir)) < 0.2) restPole = [0, isHand ? -1 : 1, 0]
    let tip: Vec3 = [0, 0, 0]
    if (isFoot) {
      const bw = rest.bone[b.name]
      tip = xpoint(xinv(bw), [bw.p[0], isFinite(groundY) ? groundY : bw.p[1], bw.p[2]])
    }
    const sx = side === 'right' ? 1 : -1
    const lateral = fwd[2] < 0 ? sx : -sx
    chains.push({
      name, kind: isHand ? 'arm' : 'leg', bones: [upper.name, lower.name, b.name], tip, restPole,
      defaultPole: isHand ? vnorm([back[0] + 0.15 * lateral, -0.6, back[2]]) : vnorm([fwd[0], 0.15, fwd[2]]),
      levelEnd: isFoot || undefined
    })
  }
  rig.chains = chains
  const find = (re: RegExp): BoneDef | undefined => rig.bones.find((b) => re.test(b.name))
  const hips = find(/^lowertorso$/i) ?? find(/hips?$/i) ?? find(/pelvis/i) ?? find(/^torso$/i)
  rig.hips = hips?.name ?? rig.root
  const hb = bones.get(rig.hips)
  if (hb && !hb.locked) hb.translatable = true
  rig.head = (find(/^head$/i) ?? find(/head$/i))?.name
  // Roblox rigs that use the standard R15 part names get the R15 joint limits.
  if (rig.source === 'roblox') for (const b of rig.bones) if (!b.limits && R15_LIMITS[b.name] && b.kind === 'motor6d') b.limits = R15_LIMITS[b.name]
}
