import type { Quat, Vec3, Xform } from './math'

export type { Quat, Vec3, Xform }

/**
 * A bone is a rigid frame. Its world transform is
 *   world(bone) = world(parent) * pre * T * post
 * where T is the animated local transform (rotation, plus position for translatable bones).
 * For Roblox Motor6D joints: pre = C0, post = C1^-1, T = Motor6D.Transform (= Pose.CFrame).
 * For glTF nodes and Roblox Bones: pre = rest local transform, post = identity.
 * `world(parent) * pre` is the joint frame: the pivot the bone rotates about.
 */
export interface BoneDef {
  name: string
  parent: string | null
  pre: Xform
  post: Xform
  /** Rotation limits for T in degrees, Euler XYZ. Omitted = free. */
  limits?: { min: Vec3; max: Vec3 }
  /**
   * Ball-joint limit (shoulders, hips), used instead of `limits`: the limb direction `axis`
   * (joint space, at rest) may swing up to `angle` degrees away from `center`, and twist about
   * its own length within `twist` degrees.
   */
  cone?: { axis: Vec3; center: Vec3; angle: number; twist: [number, number] }
  /** Whether T may carry a position (hips, roots, props). */
  translatable?: boolean
  /** Not animatable (e.g. HumanoidRootPart). */
  locked?: boolean
  /** Display / collision box in the bone frame. */
  shape?: { size: Vec3; offset?: Vec3 }
  /** Roblox: Motor6D name, or 'Bone' for skinned-mesh bones. */
  joint?: string
  kind?: 'motor6d' | 'bone' | 'node'
}

export interface IKChainDef {
  /** e.g. right_hand, left_foot */
  name: string
  kind: 'arm' | 'leg' | 'custom'
  /** upper, lower, end (e.g. RightUpperArm, RightLowerArm, RightHand) */
  bones: [string, string, string]
  /** Effector point in the end bone's frame (palm centre, sole centre). */
  tip: Vec3
  /** Direction the middle joint points at rest, in rig space (elbow: back, knee: forward). Defines the hinge. */
  restPole: Vec3
  /** Pole used when a goal gives none, in rig space relative to the chain root's parent. */
  defaultPole: Vec3
  /** Keep the end bone's rest world orientation unless a rotation is given (feet stay flat). */
  levelEnd?: boolean
}

export type RigSource = 'r15' | 'roblox' | 'gltf' | 'prop'

export interface Rig {
  id: string
  name: string
  source: RigSource
  /** 'studs' for Roblox rigs, 'meters' for glTF. All positions for this rig use these units. */
  units: 'studs' | 'meters'
  bones: BoneDef[]
  root: string
  /** Bone that carries whole-body translation (hips). */
  hips: string
  /** Bone used for look-at. */
  head?: string
  chains: IKChainDef[]
  /** Direction the rig faces at rest, in rig space. Default [0,0,-1] (Roblox). glTF rigs face +Z. */
  forward?: Vec3
  /** Placement of the rig in the scene. */
  origin: Xform
  /** Uniform scale applied to the source file's size (already baked into bones and shapes). Default 1. */
  scale?: number
  /** External mesh for display/export (glTF rigs). */
  mesh?: { type: 'glb'; path: string }
  /** Free-form source metadata (Roblox model name, etc). */
  meta?: Record<string, unknown>
}

export type EaseStyle = 'linear' | 'constant' | 'cubic' | 'elastic' | 'bounce'
/** Standard meaning: 'in' starts slow, 'out' ends slow. Applies from this key to the next. */
export type EaseDir = 'in' | 'out' | 'inout'

export interface Key {
  frame: number
  q: Quat
  p?: Vec3
  ease: EaseStyle
  dir: EaseDir
}

/** World-space effector key. Between two consecutive keys the chain is solved every frame (straight paths). */
export interface IKKey {
  frame: number
  position: Vec3
  /** World orientation of the end bone. */
  rotation?: Quat
  pole?: Vec3
  ease: EaseStyle
  dir: EaseDir
}

/** Pins a chain's effector for a frame range. With `slide`, the pin moves linearly by that offset over the range. */
export interface Contact {
  id: string
  rig: string
  chain: string
  start: number
  end: number
  position: Vec3
  slide?: Vec3
  /** World orientation of the end bone while pinned. */
  rotation?: Quat
}

/**
 * Carries one rig on a bone of another for a frame range (a sword in a hand, a hat on a head):
 * the carried rig's placement becomes world(bone) * offset, and its own keys play on top.
 */
export interface Attachment {
  id: string
  rig: string
  toRig: string
  toBone: string
  start: number
  end: number
  offset: Xform
}

export interface Marker {
  name: string
  frame: number
  value?: string
}

export interface CameraKey {
  frame: number
  position: Vec3
  target: Vec3
  fov: number
  ease: EaseStyle
  dir: EaseDir
}

export type Priority = 'Core' | 'Idle' | 'Movement' | 'Action' | 'Action2' | 'Action3' | 'Action4'

export interface Clip {
  id: string
  name: string
  /** Index of the last frame. Duration in seconds = length / fps. */
  length: number
  fps: number
  loop: boolean
  priority: Priority
  /** tracks[rigId][boneName] = keys sorted by frame */
  tracks: Record<string, Record<string, Key[]>>
  /** ikTracks[rigId][chainName] */
  ikTracks: Record<string, Record<string, IKKey[]>>
  contacts: Contact[]
  /** Optional so older project files load unchanged. */
  attachments?: Attachment[]
  markers: Marker[]
  camera: CameraKey[]
}

/** Local animated transform per bone. Missing bones are at rest (identity). */
export type Pose = Record<string, { q: Quat; p?: Vec3 }>

export interface SavedPose {
  name: string
  pose: Pose
}

export interface Project {
  format: 'inbetween'
  version: 1
  name: string
  rigs: Rig[]
  clips: Clip[]
  /** poses[rigId][poseName] */
  poses: Record<string, Record<string, Pose>>
  activeClipId: string | null
  activeRigId: string | null
}

export type EditSource = 'user' | 'agent' | 'mcp' | 'system'
