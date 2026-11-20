import { z } from 'zod'
import { contactsAt, createClip, evaluateRig, getClip, getRig, keyFrames, newId, removeKeyAt, sampleCamera } from '../clip'
import { EASE_DIRS, EASE_STYLES, TIMING_PRESETS } from '../easing'
import { exportGlb } from '../export/gltf'
import { effectorsInView, eyeUnproject, FIRST_PERSON_FOV, restEye } from '../firstPerson'
import { exportRbxmx } from '../export/rbxmx'
import { importGlbRig } from '../import/gltf'
import { importRobloxRig } from '../import/robloxRig'
import { qFromEulerDeg, qToEulerDeg, round, vdist, vround, type Vec3 } from '../math'
import {
  contactError, opAddContact, opCopyPose, opDeleteKeys, opHold, opMoveKeys, opSetCamera, opSetEasing, opSetPose,
  opWritePose, presetName, resolveEasing, summarizeKeys
} from '../ops'
import { mirrorPose } from '../pose'
import { createProp, PROP_PRESETS } from '../props'
import { createR15 } from '../r15'
import { computeWorld, effectorWorld, restWorld, rigBounds } from '../rig'
import type { Pose, Project, Rig } from '../types'
import { ALL_CHECKS, checkClip } from '../validators'
import { defineTool, type ToolDef, type ToolResult } from './registry'

const vec3 = (desc: string) => z.array(z.number()).length(3).describe(desc) as unknown as z.ZodType<Vec3>
const rigArg = z.string().optional().describe('Rig id or name. Defaults to the active rig.')
const clipArg = z.string().optional().describe('Clip id or name. Defaults to the active clip.')
const frameArg = z.number().int().min(0).describe('Frame number (whole, 0-based).')
const timingArg = z.union([
  z.enum(Object.keys(TIMING_PRESETS) as [string, ...string[]]),
  z.object({ ease: z.enum(EASE_STYLES as [string, ...string[]]), dir: z.enum(EASE_DIRS as [string, ...string[]]).optional() })
]).describe(
  'Easing from this key to the NEXT key. Presets: ' +
  Object.entries(TIMING_PRESETS).map(([k, v]) => `${k} (${v.note})`).join('; ') +
  '. Or {ease: linear|constant|cubic|elastic|bounce, dir: in|out|inout} where "in" starts slow and "out" ends slow.'
)

const CONVENTIONS =
  'Coordinates: right-handed, +Y up, ground at y=0. Characters face -Z, so -Z is forward, +Z is back, +X is the character\'s RIGHT and -X its left. ' +
  'Units are the rig\'s units (studs for Roblox rigs, meters for glTF). Rotations are Euler XYZ in degrees in the joint\'s local frame; ' +
  'for limbs hanging down, +X rotation swings the limb forward and (on the right side) +Z lifts it out to the side.'

const r = (v: Vec3): Vec3 => vround(v, 3)
const deg = (v: Vec3): Vec3 => vround(v, 1)

function mutate<T>(ctx: { store: { mutate: Function }; source: string }, label: string, touched: object, fn: (p: Project) => T): T {
  return ctx.store.mutate(ctx.source, label, fn, touched) as T
}

function describePose(rig: Rig, pose: Pose): Record<string, unknown> {
  const world = computeWorld(rig, pose)
  const effectors: Record<string, Vec3> = {}
  for (const c of rig.chains) effectors[c.name] = r(effectorWorld(rig, world, c))
  const bones: Record<string, unknown> = {}
  for (const b of rig.bones) {
    if (b.locked) continue
    const t = pose[b.name]
    const e = t ? deg(qToEulerDeg(t.q)) : [0, 0, 0]
    const entry: Record<string, unknown> = { rotation: e }
    if (t?.p && (t.p[0] || t.p[1] || t.p[2])) entry.position = r(t.p)
    bones[b.name] = entry
  }
  return { effectors, hips_world: r(world.bone[rig.hips].p), head_world: rig.head ? r(world.bone[rig.head].p) : undefined, bones }
}

export function buildTools(): ToolDef[] {
  const tools: ToolDef[] = []
  const add = <S extends z.ZodType>(t: ToolDef<S>): void => {
    tools.push(defineTool(t) as unknown as ToolDef)
  }

  // ------------------------------------------------------------------ scene / rig
  add({
    name: 'get_scene',
    description: 'List everything in the project: rigs (characters and props), clips, saved poses, and which rig and clip are active. Call this first if you do not know what exists.',
    schema: z.object({}),
    chip: () => 'reading scene',
    handler: (_a, ctx) => {
      const p = ctx.store.project
      return {
        project: p.name,
        active_rig: p.activeRigId, active_clip: p.activeClipId,
        rigs: p.rigs.map((x) => ({ id: x.id, name: x.name, type: x.source, units: x.units, bones: x.bones.length, ik_chains: x.chains.map((c) => c.name), position: r(x.origin.p) })),
        clips: p.clips.map((c) => ({ id: c.id, name: c.name, length: c.length, fps: c.fps, loop: c.loop })),
        saved_poses: Object.fromEntries(Object.entries(p.poses).map(([rid, m]) => [rid, Object.keys(m)]))
      }
    }
  })

  add({
    name: 'get_rig',
    description:
      'Read a rig before posing it: bone hierarchy, rest positions, rotation limits, IK chains with their reach, and overall dimensions. ' +
      'Use the rest positions and reach values to choose IK targets that are actually reachable. ' + CONVENTIONS,
    schema: z.object({ rig: rigArg }),
    chip: () => 'reading rig',
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      const rest = restWorld(rig)
      const b = rigBounds(rig, rest)
      return {
        id: rig.id, name: rig.name, type: rig.source, units: rig.units,
        conventions: CONVENTIONS,
        dimensions: { height: round(b.max[1] - b.min[1]), width: round(b.max[0] - b.min[0]), depth: round(b.max[2] - b.min[2]), bounds_min: r(b.min), bounds_max: r(b.max) },
        hips_bone: rig.hips, hips_rest_world: r(rest.bone[rig.hips].p), head_bone: rig.head,
        first_person: rig.head ? (() => {
          const eye = restEye(rig)
          return {
            eye_world: r(eye.position), looks_along: r(eye.forward), fov_deg: FIRST_PERSON_FOV,
            note: 'In first person the player sees from eye_world looking along looks_along; the head is hidden and only what is in front of the eye shows. ' +
              'Hands hanging at the sides are out of the picture. Use a goal\'s `view` [x, y, depth] to place a hand in the picture directly.'
          }
        })() : undefined,
        bones: rig.bones.map((x) => ({
          name: x.name, parent: x.parent,
          joint_world: r(rest.joint[x.name].p), center_world: r(rest.bone[x.name].p),
          size: x.shape ? r(x.shape.size) : undefined,
          limits_deg: x.limits ? { min: x.limits.min, max: x.limits.max } : undefined,
          ball_joint: x.cone ? { swing_max_deg: x.cone.angle, swing_center_dir: r(x.cone.center), twist_deg: x.cone.twist } : undefined,
          can_translate: x.translatable || undefined, locked: x.locked || undefined
        })),
        ik_chains: rig.chains.map((c) => {
          const root = rest.joint[c.bones[0]].p
          const tip = effectorWorld(rig, rest, c)
          const mid = rest.joint[c.bones[1]].p
          return {
            name: c.name, kind: c.kind, bones: c.bones,
            root_joint_world: r(root), effector_rest_world: r(tip),
            max_reach: round(vdist(root, mid) + vdist(mid, tip)),
            note: c.kind === 'leg' ? 'effector is the centre of the sole; y=0 puts the foot flat on the ground' : c.kind === 'arm' ? 'effector is the centre of the hand' : undefined
          }
        })
      }
    }
  })

  add({
    name: 'add_rig',
    description:
      'Add a character or prop to the scene. type "r15" adds a Roblox R15 character; "prop" adds a simple object rig from a preset (' +
      Object.entries(PROP_PRESETS).map(([k, v]) => `${k}: ${v.description}`).join(' ') +
      ') or from custom `parts` (boxes joined by pivots, for doors, machines, vehicles); "file" imports a .glb/.gltf rig or a Roblox rig JSON exported by the Inbetween Studio plugin. ' +
      'The new rig becomes active. ' + CONVENTIONS,
    schema: z.object({
      type: z.enum(['r15', 'prop', 'file']),
      name: z.string().optional().describe('Display name.'),
      preset: z.string().optional().describe('Prop preset name (type "prop").'),
      parts: z.array(z.object({
        name: z.string(), parent: z.string().nullable().optional(),
        size: vec3('Box size [x,y,z].'),
        position: vec3('Box centre at rest, in the parent part\'s frame (scene space for the root).'),
        pivot: vec3('Point the part rotates about, same frame as position. Defaults to the centre.').optional(),
        rotation: vec3('Rest rotation, Euler XYZ degrees.').optional(),
        limits: z.object({ min: vec3('min degrees'), max: vec3('max degrees') }).optional(),
        translatable: z.boolean().optional()
      })).optional().describe('Custom prop parts (type "prop" without a preset). Exactly one part must have no parent.'),
      path: z.string().optional().describe('Absolute file path (type "file").'),
      position: vec3('Where to place the rig in the scene.').optional()
    }),
    chip: (a) => `adding ${a.name ?? a.preset ?? a.type}`,
    handler: async (a, ctx) => {
      const id = newId('rig')
      let rig: Rig
      if (a.type === 'r15') rig = createR15(id, a.name ?? 'R15')
      else if (a.type === 'prop') {
        if (a.parts?.length) rig = createProp(id, a.name ?? 'Prop', a.parts)
        else {
          const preset = PROP_PRESETS[a.preset ?? '']
          if (!preset) throw new Error(`Give a preset (${Object.keys(PROP_PRESETS).join(', ')}) or custom parts.`)
          rig = createProp(id, a.name ?? a.preset!, preset.parts)
        }
      } else {
        if (!a.path) throw new Error('type "file" needs a path.')
        const bytes = await ctx.host.readFile(a.path)
        rig = /\.(glb|gltf)$/i.test(a.path)
          ? importGlbRig(bytes, id, a.name, a.path)
          : importRobloxRig(JSON.parse(new TextDecoder().decode(bytes)), id, a.name)
      }
      if (a.position) rig.origin.p = [...a.position] as Vec3
      mutate(ctx, `add rig ${rig.name}`, { rigId: rig.id }, (p) => {
        let n = rig.name, i = 2
        while (p.rigs.some((x) => x.name === n)) n = `${rig.name} ${i++}`
        rig.name = n
        p.rigs.push(rig)
        p.activeRigId = rig.id
      })
      return { added: { id: rig.id, name: rig.name, bones: rig.bones.map((b) => b.name), ik_chains: rig.chains.map((c) => c.name) }, note: 'Call get_rig to see rest positions and limits before posing.' }
    }
  })

  add({
    name: 'remove_rig',
    description: 'Remove a rig from the scene along with its tracks, contacts and saved poses. Undoable.',
    schema: z.object({ rig: z.string().describe('Rig id or name.') }),
    chip: (a) => `removing ${a.rig}`,
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      mutate(ctx, `remove rig ${rig.name}`, {}, (p) => {
        p.rigs = p.rigs.filter((x) => x.id !== rig.id)
        for (const c of p.clips) {
          delete c.tracks[rig.id]
          delete c.ikTracks[rig.id]
          c.contacts = c.contacts.filter((x) => x.rig !== rig.id)
        }
        delete p.poses[rig.id]
        if (p.activeRigId === rig.id) p.activeRigId = p.rigs[0]?.id ?? null
      })
      return `Removed ${rig.name}.`
    }
  })

  // ------------------------------------------------------------------ clips
  add({
    name: 'list_clips',
    description: 'List the animation clips in the project with length, frame rate and loop flag.',
    schema: z.object({}),
    chip: () => 'listing clips',
    handler: (_a, ctx) => ({
      active_clip: ctx.store.project.activeClipId,
      clips: ctx.store.project.clips.map((c) => ({
        id: c.id, name: c.name, length_frames: c.length, fps: c.fps, seconds: round(c.length / c.fps, 2), loop: c.loop, priority: c.priority,
        key_frames: keyFrames(c).length, contacts: c.contacts.length, markers: c.markers.length
      }))
    })
  })

  add({
    name: 'create_clip',
    description:
      'Create a new empty clip and make it active. length is the index of the last frame (a 1-second clip at 30 fps has length 30). ' +
      'Set loop=true for cycles (walk, run, idle); the pose at the last frame must then match frame 0. ' +
      'priority follows Roblox AnimationPriority: Idle for idles, Movement for locomotion, Action for attacks/emotes.',
    schema: z.object({
      name: z.string(),
      length: z.number().int().min(1).max(100000).default(30).describe('Last frame index.'),
      fps: z.number().int().min(1).max(120).default(30),
      loop: z.boolean().default(false),
      priority: z.enum(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']).default('Action')
    }),
    chip: (a) => `creating clip ${a.name}`,
    handler: (a, ctx) => {
      const clip = createClip(a.name, a.length, a.fps, a.loop)
      clip.priority = a.priority
      mutate(ctx, `create clip ${a.name}`, { clipId: clip.id }, (p) => {
        p.clips.push(clip)
        p.activeClipId = clip.id
      })
      return { created: { id: clip.id, name: clip.name, length: clip.length, fps: clip.fps, loop: clip.loop, priority: clip.priority } }
    }
  })

  add({
    name: 'update_clip',
    description: 'Change a clip\'s name, length (last frame index), fps, loop flag or priority, make it the active clip, or delete it. Shortening a clip does not delete keys beyond the new end.',
    schema: z.object({
      clip: clipArg, name: z.string().optional(), length: z.number().int().min(1).optional(), fps: z.number().int().min(1).max(120).optional(),
      loop: z.boolean().optional(), priority: z.enum(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']).optional(),
      activate: z.boolean().optional().describe('Make this the active clip.'), delete: z.boolean().optional()
    }),
    chip: (a) => (a.delete ? 'deleting clip' : 'updating clip'),
    handler: (a, ctx) => {
      const clip = getClip(ctx.store.project, a.clip)
      if (a.activate && a.name === undefined && a.length === undefined && a.fps === undefined && a.loop === undefined && a.priority === undefined && !a.delete) {
        ctx.store.setActive({ activeClipId: clip.id })
        return `Active clip is now ${clip.name}.`
      }
      mutate(ctx, a.delete ? `delete clip ${clip.name}` : `update clip ${clip.name}`, { clipId: clip.id }, (p) => {
        if (a.delete) {
          p.clips = p.clips.filter((c) => c.id !== clip.id)
          if (p.activeClipId === clip.id) p.activeClipId = p.clips[0]?.id ?? null
          return
        }
        const c = getClip(p, clip.id)
        if (a.name !== undefined) c.name = a.name
        if (a.length !== undefined) c.length = a.length
        if (a.fps !== undefined) c.fps = a.fps
        if (a.loop !== undefined) c.loop = a.loop
        if (a.priority !== undefined) c.priority = a.priority
        if (a.activate) p.activeClipId = c.id
      })
      return a.delete ? `Deleted ${clip.name}.` : { updated: clip.id }
    }
  })

  add({
    name: 'get_clip',
    description:
      'Read a clip: settings, which frames have keys (per rig), easing on each key frame, contacts, markers and camera keys. ' +
      'Pass `frame` to also get the evaluated pose at that frame: effector world positions and every bone\'s local rotation. ' + CONVENTIONS,
    schema: z.object({ clip: clipArg, frame: frameArg.optional().describe('Also return the full pose at this frame.'), rig: rigArg }),
    chip: (a) => (a.frame !== undefined ? `reading frame ${a.frame}` : 'reading clip'),
    handler: (a, ctx) => {
      const p = ctx.store.project
      const clip = getClip(p, a.clip)
      const out: Record<string, unknown> = {
        id: clip.id, name: clip.name, length_frames: clip.length, fps: clip.fps, seconds: round(clip.length / clip.fps, 2), loop: clip.loop, priority: clip.priority,
        rigs: p.rigs.map((rig) => {
          const s = summarizeKeys(clip, rig)
          const tracks = clip.tracks[rig.id] ?? {}
          const easing: Record<number, string> = {}
          for (const f of s.frames) {
            for (const b in tracks) {
              const k = tracks[b].find((x) => x.frame === f)
              if (k) {
                easing[f] = presetName(k)
                break
              }
            }
          }
          return {
            rig: rig.id, name: rig.name, full_pose_key_frames: s.allBonesFrames,
            partial_keys: Object.keys(s.bones).length ? s.bones : undefined,
            easing_out_of_frame: easing,
            straight_path_keys: clip.ikTracks[rig.id] ? Object.fromEntries(Object.entries(clip.ikTracks[rig.id]).map(([c, k]) => [c, k.map((x) => x.frame)])) : undefined
          }
        }),
        contacts: clip.contacts.map((c) => ({ id: c.id, rig: c.rig, chain: c.chain, start: c.start, end: c.end, position: r(c.position), slide: c.slide ? r(c.slide) : undefined })),
        markers: clip.markers,
        camera_keys: clip.camera.map((k) => ({ frame: k.frame, position: r(k.position), target: r(k.target), fov: k.fov }))
      }
      if (a.frame !== undefined) {
        const rig = getRig(p, a.rig)
        out.pose = { frame: a.frame, rig: rig.id, ...describePose(rig, evaluateRig(clip, rig, a.frame)), active_contacts: contactsAt(clip, rig.id, a.frame).map((c) => c.chain) }
      }
      return out
    }
  })

  // ------------------------------------------------------------------ posing
  add({
    name: 'set_pose',
    description:
      'Set a pose at a frame by goals and write keyframes. This is the main animation tool: say where the hands, feet, hips and head should be and the IK solver works out the joints (elbows and knees always bend the right way, joint limits are enforced). ' +
      'The pose starts from whatever the clip already evaluates to at that frame (or `from`), then applies in order: hips, direct bone rotations, IK goals, look_at. ' +
      'By default every bone gets a key so the frame is a complete pose. ' +
      'hips.position is an OFFSET from the rest position ([0,-0.5,0] lowers the hips half a unit); feet without a goal stay where they were when the hips move (keep_feet), so "lower the hips" bends the knees. ' +
      'Goal positions are absolute scene coordinates: use get_rig for rest positions and max reach. A foot goal at y=0 is flat on the ground. ' +
      'Goal rotation is relative to the end bone\'s rest orientation ([0,0,0] = hand hanging / foot flat and forward; foot [-30,0,0] points the toes down). ' +
      'pole is a point the elbow/knee should aim toward. ' +
      'For first-person animation, give a hand goal a `view` [x, y, depth] instead of a position to place it directly in the first-person picture. ' +
      'The result lists where each effector ended up and any goal that was out of reach or limited, so read it. ' + CONVENTIONS,
    schema: z.object({
      frame: frameArg, clip: clipArg, rig: rigArg,
      hips: z.object({
        position: vec3('Offset from rest [x,y,z].').optional(),
        rotation: vec3('Euler XYZ degrees. Y turns the body, X leans forward(+)/back(-), Z tilts sideways.').optional()
      }).optional(),
      goals: z.record(z.string(), z.object({
        position: vec3('Effector target in scene space.').optional(),
        view: vec3('First-person placement instead of position: [x, y, depth]. x and y are where the effector sits in the first-person picture (-1 left/bottom edge, 0 centre, +1 right/top edge) and depth is how far in front of the eye, in rig units. E.g. [0.45, -0.5, 1.6] is lower right, a comfortable held-item position.').optional(),
        rotation: vec3('End bone orientation, Euler XYZ degrees relative to its rest orientation.').optional(),
        pole: vec3('Scene-space point the elbow/knee aims at.').optional()
      })).optional().describe('IK goals keyed by chain name (e.g. right_hand, left_hand, right_foot, left_foot; see get_rig).'),
      bones: z.record(z.string(), z.object({
        rotation: vec3('Local Euler XYZ degrees (absolute, not additive).').optional(),
        position: vec3('Local position offset, translatable bones only.').optional()
      })).optional().describe('Direct local rotations by bone name, for spine, head, hands, fingers, or prop parts.'),
      look_at: vec3('Scene-space point for the head to face.').optional(),
      keep_feet: z.boolean().optional().describe('Keep feet without goals planted where they were. Default true. Set false for jumps and falls.'),
      from: z.string().optional().describe('"rest" to start from the rest pose, or a saved pose name, instead of the current pose at this frame.'),
      timing: timingArg.optional(),
      straight_paths: z.array(z.string()).optional().describe('Chains whose effector should travel in a straight line between this key and the neighbouring keys also marked straight (default is the natural arc from joint rotation).'),
      only_changed: z.boolean().optional().describe('Key only the bones this call changed instead of the whole pose.')
    }),
    chip: (a) => `posing frame ${a.frame}`,
    handler: (a, ctx) => {
      const p0 = ctx.store.project
      const rig0 = getRig(p0, a.rig)
      const clip0 = getClip(p0, a.clip)
      if (!a.hips && !a.goals && !a.bones && !a.look_at && !a.from) {
        // A bare set_pose keys the current pose: useful for holds.
      }
      // Resolve first-person `view` placements to scene positions.
      let goals: Record<string, { position: Vec3; rotation?: Vec3; pole?: Vec3 }> | undefined
      if (a.goals) {
        goals = {}
        for (const name in a.goals) {
          const g = a.goals[name]
          if (g.view) goals[name] = { ...g, position: eyeUnproject(restEye(rig0), g.view[0], g.view[1], g.view[2], 16 / 9) }
          else if (g.position) goals[name] = { ...g, position: g.position }
          else throw new Error(`Goal "${name}" needs a position or a view.`)
        }
      }
      let base: Pose | undefined
      if (a.from === 'rest') base = {}
      else if (a.from) {
        base = p0.poses[rig0.id]?.[a.from]
        if (!base) throw new Error(`No saved pose "${a.from}" for ${rig0.name}. Saved: ${Object.keys(p0.poses[rig0.id] ?? {}).join(', ') || '(none)'}`)
      }
      const res = mutate(ctx, `pose frame ${a.frame}`, { clipId: clip0.id, rigId: rig0.id, frames: [a.frame] }, (p) =>
        opSetPose({
          clip: getClip(p, clip0.id), rig: getRig(p, rig0.id), frame: a.frame,
          spec: { hips: a.hips, goals, bones: a.bones, lookAt: a.look_at, keepFeet: a.keep_feet },
          base, easing: resolveEasing(a.timing as never), straight: a.straight_paths, onlyChanged: a.only_changed
        }))
      const warnings: string[] = []
      for (const ik of res.ik) if (!ik.reached) warnings.push(`${ik.chain}: missed target by ${ik.error.toFixed(2)} (${ik.note ?? 'unreachable'})`)
      if (res.clampedBones.length) warnings.push(`rotation clamped to joint limits on: ${res.clampedBones.join(', ')}`)
      warnings.push(...res.notes)
      return {
        frame: a.frame, keyed_bones: res.written.length,
        effectors: Object.fromEntries(Object.entries(res.effectors).map(([k, v]) => [k, r(v)])),
        feet_kept_planted: res.keptFeet.length ? res.keptFeet : undefined,
        warnings: warnings.length ? warnings : undefined
      }
    }
  })

  add({
    name: 'save_pose',
    description: 'Save the pose at a frame to the rig\'s pose library under a name, for reuse with load_pose (e.g. "guard", "contact_L").',
    schema: z.object({ name: z.string().min(1), frame: frameArg, clip: clipArg, rig: rigArg }),
    chip: (a) => `saving pose ${a.name}`,
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      const clip = getClip(ctx.store.project, a.clip)
      const pose = evaluateRig(clip, rig, a.frame)
      mutate(ctx, `save pose ${a.name}`, {}, (p) => {
        ;(p.poses[rig.id] ??= {})[a.name] = pose
      })
      return `Saved pose "${a.name}" for ${rig.name} from frame ${a.frame}.`
    }
  })

  add({
    name: 'list_poses',
    description: 'List the saved poses in the pose library for a rig.',
    schema: z.object({ rig: rigArg }),
    chip: () => 'listing poses',
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      return { rig: rig.id, poses: Object.keys(ctx.store.project.poses[rig.id] ?? {}) }
    }
  })

  add({
    name: 'load_pose',
    description: 'Key a saved pose at a frame. mirror=true flips it left/right. `bones` limits it to some bones (e.g. only the arms). Set delete=true to remove the saved pose instead.',
    schema: z.object({
      name: z.string(), frame: frameArg.optional(), clip: clipArg, rig: rigArg, mirror: z.boolean().optional(),
      bones: z.array(z.string()).optional(), timing: timingArg.optional(), delete: z.boolean().optional()
    }),
    chip: (a) => (a.delete ? `deleting pose ${a.name}` : `loading pose ${a.name}`),
    handler: (a, ctx) => {
      const p0 = ctx.store.project
      const rig = getRig(p0, a.rig)
      const saved = p0.poses[rig.id]?.[a.name]
      if (!saved) throw new Error(`No saved pose "${a.name}" for ${rig.name}. Saved: ${Object.keys(p0.poses[rig.id] ?? {}).join(', ') || '(none)'}`)
      if (a.delete) {
        mutate(ctx, `delete pose ${a.name}`, {}, (p) => {
          delete p.poses[rig.id][a.name]
        })
        return `Deleted pose "${a.name}".`
      }
      if (a.frame === undefined) throw new Error('load_pose needs a frame.')
      const clip = getClip(p0, a.clip)
      const pose = a.mirror ? mirrorPose(rig, saved) : saved
      const full: Pose = { ...pose }
      for (const b of rig.bones) if (!b.locked && !full[b.name]) full[b.name] = { q: [0, 0, 0, 1] }
      const n = mutate(ctx, `load pose ${a.name} at ${a.frame}`, { clipId: clip.id, rigId: rig.id, frames: [a.frame] }, (p) =>
        opWritePose(getClip(p, clip.id), getRig(p, rig.id), a.frame!, full, resolveEasing(a.timing as never), a.bones).length)
      return { frame: a.frame, keyed_bones: n, mirrored: !!a.mirror }
    }
  })

  add({
    name: 'mirror_pose',
    description:
      'Flip the pose at a frame left/right (swaps Left/Right bones and mirrors the spine and hips) and key the result at `to_frame` (default: the same frame). ' +
      'Use it to build the second half of a walk or run cycle from the first half.',
    schema: z.object({ frame: frameArg, to_frame: frameArg.optional(), clip: clipArg, rig: rigArg, timing: timingArg.optional() }),
    chip: (a) => `mirroring frame ${a.frame}`,
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      const clip = getClip(ctx.store.project, a.clip)
      const to = a.to_frame ?? a.frame
      const n = mutate(ctx, `mirror frame ${a.frame} to ${to}`, { clipId: clip.id, rigId: rig.id, frames: [to] }, (p) =>
        opCopyPose(getClip(p, clip.id), getRig(p, rig.id), a.frame, to, { mirror: true, easing: resolveEasing(a.timing as never) }).length)
      return { mirrored_from: a.frame, to_frame: to, keyed_bones: n }
    }
  })

  add({
    name: 'copy_pose_to_frame',
    description:
      'Copy the pose at one frame to another frame (all bones, or just `bones`). Use it to close loops (copy frame 0 to the last frame), to hold a pose, or to reuse a key pose. mirror=true flips left/right while copying.',
    schema: z.object({
      from_frame: frameArg, to_frame: frameArg, clip: clipArg, rig: rigArg, bones: z.array(z.string()).optional(),
      mirror: z.boolean().optional(), timing: timingArg.optional()
    }),
    chip: (a) => `copying frame ${a.from_frame} to ${a.to_frame}`,
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      const clip = getClip(ctx.store.project, a.clip)
      const n = mutate(ctx, `copy frame ${a.from_frame} to ${a.to_frame}`, { clipId: clip.id, rigId: rig.id, frames: [a.to_frame] }, (p) =>
        opCopyPose(getClip(p, clip.id), getRig(p, rig.id), a.from_frame, a.to_frame, { mirror: a.mirror, bones: a.bones, easing: resolveEasing(a.timing as never) }).length)
      return { from_frame: a.from_frame, to_frame: a.to_frame, keyed_bones: n }
    }
  })

  // ------------------------------------------------------------------ timing
  add({
    name: 'set_timing',
    description:
      'Retime keys and set easing. All three parts are optional and applied in this order: ' +
      '`moves` shifts every key on a frame to another frame (all moves happen at once, so swapping is safe); ' +
      '`holds` freezes the pose at a frame for N frames by duplicating its keys N frames later (ripple=true pushes later keys, contacts and markers back to make room); ' +
      '`easing` sets how motion leaves the keys on the given frames toward the next key. ' +
      'Block with "stepped" first, then switch to eased timing once the poses read well. Applies to the active rig unless all_rigs is true. Contacts and markers only move with ripple holds.',
    schema: z.object({
      clip: clipArg, rig: rigArg, all_rigs: z.boolean().optional(),
      moves: z.array(z.object({ from: frameArg, to: frameArg })).optional(),
      holds: z.array(z.object({ frame: frameArg, duration: z.number().int().min(1), ripple: z.boolean().optional() })).optional(),
      easing: z.array(z.object({
        frames: z.union([z.array(frameArg), z.literal('all')]).describe('Key frames to change, or "all".'),
        timing: timingArg, bones: z.array(z.string()).optional()
      })).optional()
    }),
    chip: (a) => (a.moves?.length ? 'retiming keys' : a.holds?.length ? 'adding holds' : 'setting easing'),
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      const clip = getClip(ctx.store.project, a.clip)
      const rigId = a.all_rigs ? null : rig.id
      const frames = [...(a.moves ?? []).map((m) => m.to), ...(a.holds ?? []).map((h) => h.frame + h.duration)]
      const out = mutate(ctx, 'set timing', { clipId: clip.id, rigId: rig.id, frames }, (p) => {
        const c = getClip(p, clip.id)
        const res = { moved_keys: 0, hold_keys: 0, eased_keys: 0 }
        if (a.moves?.length) res.moved_keys = opMoveKeys(c, rigId, a.moves)
        for (const h of a.holds ?? []) res.hold_keys += opHold(c, rigId, h.frame, h.duration, h.ripple ?? false)
        for (const e of a.easing ?? []) res.eased_keys += opSetEasing(c, rigId, e.frames as number[] | 'all', resolveEasing(e.timing as never)!, e.bones)
        return { ...res, length: c.length, key_frames: keyFrames(c, rig.id) }
      })
      if (a.moves?.length && !out.moved_keys) return { ...out, warning: 'No keys were found on the `from` frames.' }
      return out
    }
  })

  add({
    name: 'delete_keys',
    description: 'Delete keys on the given frames (all bones, or just `bones`). Use to remove a bad in-between or clear a frame before re-posing.',
    schema: z.object({ frames: z.array(frameArg).min(1), bones: z.array(z.string()).optional(), clip: clipArg, rig: rigArg }),
    chip: (a) => `deleting keys at ${a.frames.join(', ')}`,
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      const clip = getClip(ctx.store.project, a.clip)
      const n = mutate(ctx, `delete keys at ${a.frames.join(',')}`, { clipId: clip.id, rigId: rig.id }, (p) => opDeleteKeys(getClip(p, clip.id), rig.id, a.frames, a.bones))
      return { deleted_keys: n }
    }
  })

  // ------------------------------------------------------------------ contacts, markers, camera
  add({
    name: 'add_contact',
    description:
      'Plant a foot or hand: pin an IK chain\'s effector over a frame range so it cannot slide, whatever the hips and body do between keys. ' +
      'The pin is where the effector is at `start` unless `position` is given. Feet are held flat unless `rotation` is given. ' +
      'For in-place cycles (walk/run on the spot) use `slide`: the total distance the planted foot travels over the range, e.g. [0,0,1.6] slides it 1.6 units backward at constant speed like a treadmill. ' +
      'The result reports whether the limb can actually reach the pin for the whole range. Pass remove (a contact id) to delete a contact instead.',
    schema: z.object({
      chain: z.string().optional().describe('IK chain name, e.g. left_foot.'),
      start: frameArg.optional(), end: frameArg.optional(),
      position: vec3('Pin position in scene space. Defaults to the effector position at `start`.').optional(),
      slide: vec3('Total pin displacement over the range (linear).').optional(),
      rotation: vec3('End bone orientation while pinned, Euler XYZ degrees relative to rest.').optional(),
      remove: z.string().optional().describe('Contact id to remove (see get_clip).'),
      clip: clipArg, rig: rigArg
    }),
    chip: (a) => (a.remove ? 'removing contact' : `planting ${a.chain?.replace('_', ' ')} ${a.start}-${a.end}`),
    handler: (a, ctx) => {
      const rig = getRig(ctx.store.project, a.rig)
      const clip = getClip(ctx.store.project, a.clip)
      if (a.remove) {
        if (!clip.contacts.some((c) => c.id === a.remove)) throw new Error(`No contact with id "${a.remove}". Contacts: ${clip.contacts.map((c) => `${c.id} (${c.chain} ${c.start}-${c.end})`).join(', ') || '(none)'}`)
        mutate(ctx, 'remove contact', { clipId: clip.id }, (p) => {
          const c = getClip(p, clip.id)
          c.contacts = c.contacts.filter((x) => x.id !== a.remove)
        })
        return `Removed contact ${a.remove}.`
      }
      if (!a.chain || a.start === undefined || a.end === undefined) throw new Error('add_contact needs chain, start and end.')
      return mutate(ctx, `plant ${a.chain} ${a.start}-${a.end}`, { clipId: clip.id, rigId: rig.id }, (p) => {
        const c = getClip(p, clip.id), rg = getRig(p, rig.id)
        const contact = opAddContact(c, rg, a.chain!, a.start!, a.end!, { position: a.position, slide: a.slide, rotation: a.rotation })
        const err = contactError(c, rg, contact)
        const tol = 0.05
        return {
          contact: { id: contact.id, chain: contact.chain, start: contact.start, end: contact.end, position: r(contact.position), slide: contact.slide },
          holds: err.worst <= tol,
          warning: err.worst > tol ? `The limb cannot reach the pin for the whole range: off by up to ${err.worst.toFixed(2)} at frame ${err.frame}. Move the hips closer or lower there, or change the range/position.` : undefined
        }
      })
    }
  })

  add({
    name: 'add_marker',
    description:
      'Add a named event marker on a frame (exported as a Roblox KeyframeMarker, read in game with GetMarkerReachedSignal). Use for gameplay timing: "hit" on the impact frame, "footstep", "spawn_vfx". Pass remove=true to delete the marker with that name and frame.',
    schema: z.object({ name: z.string().min(1), frame: frameArg, value: z.string().optional(), remove: z.boolean().optional(), clip: clipArg }),
    chip: (a) => `${a.remove ? 'removing' : 'marking'} "${a.name}" at ${a.frame}`,
    handler: (a, ctx) => {
      const clip = getClip(ctx.store.project, a.clip)
      mutate(ctx, `${a.remove ? 'remove' : 'add'} marker ${a.name}`, { clipId: clip.id }, (p) => {
        const c = getClip(p, clip.id)
        c.markers = c.markers.filter((m) => !(m.name === a.name && m.frame === a.frame))
        if (!a.remove) {
          c.markers.push({ name: a.name, frame: a.frame, ...(a.value ? { value: a.value } : {}) })
          c.markers.sort((x, y) => x.frame - y.frame)
        }
      })
      return a.remove ? `Removed marker "${a.name}" at frame ${a.frame}.` : `Marker "${a.name}" at frame ${a.frame}.`
    }
  })

  add({
    name: 'set_camera',
    description:
      'Key the cutscene camera at a frame: where it is, what it looks at, and its vertical field of view in degrees. Keys interpolate with the given timing. ' +
      'Preview with view "camera" to see through it; video export can render from it. Pass remove=true to delete the camera key on that frame. ' + CONVENTIONS,
    schema: z.object({
      frame: frameArg, position: vec3('Camera position in scene space.').optional(), target: vec3('Point the camera looks at.').optional(),
      fov: z.number().min(5).max(120).optional().describe('Vertical field of view in degrees. Default 50.'),
      timing: timingArg.optional(), remove: z.boolean().optional(), clip: clipArg
    }),
    chip: (a) => `camera at frame ${a.frame}`,
    handler: (a, ctx) => {
      const clip = getClip(ctx.store.project, a.clip)
      if (a.remove) {
        mutate(ctx, `remove camera key ${a.frame}`, { clipId: clip.id }, (p) => removeKeyAt(getClip(p, clip.id).camera, a.frame))
        return `Removed camera key at frame ${a.frame}.`
      }
      const cur = sampleCamera(clip.camera, a.frame)
      const position = a.position ?? cur?.position
      const target = a.target ?? cur?.target
      if (!position || !target) throw new Error('The first camera key needs both position and target.')
      const e = resolveEasing(a.timing as never) ?? { ease: 'cubic' as const, dir: 'inout' as const }
      mutate(ctx, `camera key ${a.frame}`, { clipId: clip.id, frames: [a.frame] }, (p) =>
        opSetCamera(getClip(p, clip.id), { frame: a.frame, position: [...position] as Vec3, target: [...target] as Vec3, fov: a.fov ?? cur?.fov ?? 50, ease: e.ease, dir: e.dir }))
      return { camera_key: a.frame, position: r(position), target: r(target), fov: a.fov ?? cur?.fov ?? 50 }
    }
  })

  // ------------------------------------------------------------------ eyes and checks
  add({
    name: 'preview',
    description:
      'Render the animation and LOOK at it. Returns one image: a contact sheet with a cell per frame per view, each labelled with its frame number, over a ground grid (1 unit per square). ' +
      'Default is 8 evenly spaced frames from the front and side. Use frames="keys" to see exactly the key poses while blocking, or list specific frames to inspect a problem. ' +
      'Views: front (camera in front of the character, so the character\'s right hand is on the image\'s left), back, side (seen from the character\'s right; forward is to the image\'s right), left (seen from its left; forward is to the image\'s left), top (forward is up the image), three_quarter, camera (the cutscene camera), first_person (through the character\'s eyes with the head hidden: fixed at the rest head position looking straight ahead, 16:9, 70 degree field of view, the way a game camera that follows the character sees it), head_cam (same, but locked to the animated head so head motion moves the picture). ' +
      'With a first-person view the result also lists, per frame, whether each hand and foot is inside the picture and where (x, y from -1 to 1), so you can tell when the action leaves the frame. ' +
      'onion_skin ghosts the previous and next sampled poses into each cell to show spacing; trails draws the path of the named IK chains or bones through the whole clip to check arcs. ' +
      'Always preview after blocking and again after the final change.',
    schema: z.object({
      clip: clipArg,
      frames: z.union([z.array(frameArg).min(1).max(24), z.literal('keys')]).optional().describe('Specific frames, or "keys" for the key frames.'),
      count: z.number().int().min(1).max(24).optional().describe('Number of evenly spaced frames when `frames` is omitted. Default 8.'),
      views: z.array(z.enum(['front', 'back', 'side', 'left', 'top', 'three_quarter', 'camera', 'first_person', 'head_cam'])).min(1).max(4).optional().describe('Default ["front","side"].'),
      onion_skin: z.boolean().optional(),
      trails: z.array(z.string()).optional().describe('IK chain or bone names to draw motion trails for, e.g. ["right_hand"].'),
      rigs: z.array(z.string()).optional().describe('Rigs to show. Default: all.'),
      rig: rigArg.describe('Whose eyes the first-person views look through. Defaults to the active rig.')
    }),
    chip: (a) => (a.views?.some((v) => v === 'first_person' || v === 'head_cam') ? 'previewing in first person' : 'previewing'),
    handler: async (a, ctx): Promise<ToolResult> => {
      const p = ctx.store.project
      const clip = getClip(p, a.clip)
      let frames: number[]
      if (a.frames === 'keys') {
        frames = keyFrames(clip)
        if (!frames.length) frames = [0]
        if (frames.length > 24) {
          const step = (frames.length - 1) / 23
          frames = Array.from({ length: 24 }, (_, i) => frames[Math.round(i * step)])
        }
      } else if (a.frames) frames = [...a.frames]
      else {
        const n = Math.min(a.count ?? 8, clip.length + 1)
        frames = n === 1 ? [0] : Array.from({ length: n }, (_, i) => Math.round((i * clip.length) / (n - 1)))
      }
      frames = [...new Set(frames)].sort((x, y) => x - y)
      const views = a.views ?? ['front', 'side']
      if (views.includes('camera') && !clip.camera.length) throw new Error('This clip has no camera keys. Use set_camera first, or choose another view.')
      const rigIds = a.rigs?.length ? a.rigs.map((x) => getRig(p, x).id) : p.rigs.map((x) => x.id)
      const cells = frames.length * views.length
      const cellSize = cells <= 4 ? 512 : cells <= 9 ? 448 : cells <= 16 ? 384 : cells <= 30 ? 300 : 240
      const fpViews = views.filter((v): v is 'first_person' | 'head_cam' => v === 'first_person' || v === 'head_cam')
      const subject = fpViews.length ? getRig(p, a.rig) : undefined
      if (subject && !subject.head) throw new Error(`"${subject.name}" has no head bone, so it has no first-person view. Pass rig: a character rig.`)
      const img = await ctx.host.renderPreview({ project: p, clipId: clip.id, rigIds, frames, views, onionSkin: !!a.onion_skin, trails: a.trails ?? [], cellSize, subjectRigId: subject?.id })
      const inView = subject ? Object.fromEntries(fpViews.map((v) => {
        const table = effectorsInView(clip, subject, frames, v, 16 / 9)
        return [v, Object.fromEntries(Object.entries(table).map(([f, chains]) => [`f${f}`, Object.fromEntries(Object.entries(chains).map(([c, e]) => [c, e.visible ? `in view at x ${e.x}, y ${e.y}, ${e.depth} ahead` : e.depth <= 0.1 ? 'not visible (beside or behind the eye)' : 'out of frame']))]))]
      })) : undefined
      return {
        text: JSON.stringify({ clip: clip.name, frames, views, first_person_visibility: inView, layout: 'cells read left to right, top to bottom; each view is its own block of rows, in the order of `views`', length_frames: clip.length }),
        images: [img]
      }
    }
  })

  add({
    name: 'check',
    description:
      'Run the automatic validators over every frame of a clip and return the problems with frame numbers. Checks: ' +
      'foot_sliding (a planted foot/hand drifting off its contact), joint_limits (a joint bent past its limits, e.g. a hyperextended elbow), ' +
      'self_intersection (body parts passing through each other), jitter (single-frame velocity spikes or frame-to-frame reversals), ' +
      'loop_mismatch (first and last frame differ on a looping clip), ground_penetration (feet or other parts below y=0). ' +
      'Fix what it reports, then run it again. An empty list means the clip is mechanically clean; it does not judge whether the motion looks good, so still preview.',
    schema: z.object({
      clip: clipArg, rig: z.string().optional().describe('Rig id or name. Default: every rig.'),
      checks: z.array(z.enum(ALL_CHECKS as [string, ...string[]])).optional().describe('Subset of checks to run. Default: all.')
    }),
    chip: () => 'checking',
    handler: (a, ctx) => {
      const p = ctx.store.project
      const clip = getClip(p, a.clip)
      const rigs = a.rig ? [getRig(p, a.rig)] : p.rigs
      const problems = rigs.flatMap((rig) => checkClip(clip, rig, { checks: a.checks as never }))
      return {
        clip: clip.name, ok: problems.length === 0, problem_count: problems.length,
        problems: problems.slice(0, 60).map((x) => ({ check: x.check, severity: x.severity, rig: rigs.length > 1 ? x.rig : undefined, frames: x.frames[0] === x.frames[1] ? [x.frames[0]] : x.frames, subject: x.subject, message: x.message })),
        truncated: problems.length > 60 ? `${problems.length - 60} more not shown` : undefined
      }
    }
  })

  // ------------------------------------------------------------------ export / history
  add({
    name: 'export',
    description:
      'Export a clip to a file and return its path. Formats: ' +
      '"rbxmx" = Roblox KeyframeSequence model file to drag into Studio (one rig; Roblox rigs only); ' +
      '"glb" = glTF binary with the rig and baked animation, for Unity, Unreal, Godot, Blender; ' +
      '"mp4", "gif", "webm" = rendered video (transparent background needs gif or webm; mp4 cannot store alpha); ' +
      '"json" = the clip as Inbetween JSON. ' +
      'Without `path` the file goes to the app\'s exports folder. Run check and preview before exporting.',
    schema: z.object({
      format: z.enum(['rbxmx', 'glb', 'mp4', 'gif', 'webm', 'json']),
      clip: clipArg, rig: rigArg,
      path: z.string().optional().describe('Absolute output path. Default: exports folder, named after the clip.'),
      width: z.number().int().min(64).max(3840).optional().describe('Video width in pixels. Default 1280.'),
      height: z.number().int().min(64).max(2160).optional().describe('Video height. Default 720.'),
      fps: z.number().int().min(1).max(60).optional().describe('Video frame rate. Default: the clip\'s fps.'),
      background: z.string().optional().describe('"transparent" or a hex colour like "#101014". Default: the app theme background.'),
      camera: z.enum(['track', 'front', 'back', 'side', 'left', 'top', 'three_quarter', 'first_person', 'head_cam']).optional().describe('Video camera: "track" uses the clip\'s camera keys; "first_person" and "head_cam" look through the eyes of `rig` with its head hidden. Default three_quarter (or track if the clip has camera keys).')
    }),
    chip: (a) => `exporting ${a.format}`,
    handler: async (a, ctx) => {
      const p = ctx.store.project
      const clip = getClip(p, a.clip)
      const safe = clip.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'clip'
      const path = a.path ?? ctx.host.resolveExportPath(`${safe}.${a.format}`)
      if (a.format === 'rbxmx') {
        const rig = getRig(p, a.rig)
        const out = await ctx.host.writeFile(path, exportRbxmx(clip, rig))
        return { exported: out, format: 'rbxmx', rig: rig.name, next: 'Drag the file into Roblox Studio (or use the Inbetween Studio plugin\'s Import button), then publish it with the Animation Editor.' }
      }
      if (a.format === 'glb') {
        const rig = getRig(p, a.rig)
        let source: Uint8Array | undefined
        if (rig.mesh?.path) {
          try {
            source = await ctx.host.readFile(rig.mesh.path)
          } catch { /* fall back to generated boxes */ }
        }
        const out = await ctx.host.writeFile(path, exportGlb(clip, rig, { source }))
        return { exported: out, format: 'glb', rig: rig.name }
      }
      if (a.format === 'json') {
        const out = await ctx.host.writeFile(path, JSON.stringify({ format: 'inbetween-clip', version: 1, clip, rigs: p.rigs.filter((x) => clip.tracks[x.id]) }, null, 1))
        return { exported: out, format: 'json' }
      }
      if (a.format === 'mp4' && a.background === 'transparent') throw new Error('MP4 (H.264) cannot store transparency. Use format "webm" or "gif" for a transparent background.')
      const res = await ctx.host.renderVideo({
        project: p, clipId: clip.id, format: a.format, path,
        width: a.width ?? 1280, height: a.height ?? 720, fps: a.fps ?? clip.fps,
        background: a.background ?? 'theme', camera: a.camera ?? (clip.camera.length ? 'track' : 'three_quarter'), rigId: getRig(p, a.rig).id
      })
      return { exported: res.path, format: a.format, frames: res.frames }
    }
  })

  add({
    name: 'undo',
    description: 'Undo the most recent edits (yours or the user\'s; they share one history). steps defaults to 1. Set redo=true to redo instead.',
    schema: z.object({ steps: z.number().int().min(1).max(50).optional(), redo: z.boolean().optional() }),
    chip: (a) => (a.redo ? 'redoing' : 'undoing'),
    handler: (a, ctx) => {
      const labels: string[] = []
      for (let i = 0; i < (a.steps ?? 1); i++) {
        const l = a.redo ? ctx.store.redo(ctx.source) : ctx.store.undo(ctx.source)
        if (!l) break
        labels.push(l)
      }
      if (!labels.length) return a.redo ? 'Nothing to redo.' : 'Nothing to undo.'
      return { [a.redo ? 'redone' : 'undone']: labels }
    }
  })

  return tools
}

export { CONVENTIONS, qFromEulerDeg }
