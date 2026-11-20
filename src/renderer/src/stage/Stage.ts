import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { evaluateRig, sampleCamera } from '@core/clip'
import { firstPersonCamera, type FirstPersonMode } from '@core/firstPerson'
import { computeWorld, effectorWorld, rigBounds, type WorldPose } from '@core/rig'
import type { Clip, Pose, Project, Rig, Vec3 } from '@core/types'

export interface StageColors {
  background: string
  ground: string
  grid: string
  body: string
  /** Preview-only tints so left and right limbs can be told apart in a still image. */
  bodyRight: string
  bodyLeft: string
  edge: string
  accent: string
  ghostPrev: string
  ghostNext: string
  label: string
}

export const THEMES: Record<'light' | 'dark', StageColors> = {
  // A light table and a dim studio. Ghost tints follow pencil-test tradition: warm for past frames, blue for upcoming.
  light: { background: '#e9eaee', ground: '#dfe1e6', grid: '#b9bdc8', body: '#f7f6f3', bodyRight: '#f2c4b6', bodyLeft: '#b9cdf3', edge: '#3c4150', accent: '#2f62f0', ghostPrev: '#e0563f', ghostNext: '#2f62f0', label: '#1c1e24' },
  dark: { background: '#1b1d23', ground: '#20232a', grid: '#3a3f4b', body: '#b9bcc6', bodyRight: '#d9a394', bodyLeft: '#93acdf', edge: '#0e1016', accent: '#6f9bff', ghostPrev: '#ff7a5c', ghostNext: '#6f9bff', label: '#eceef3' }
}

export type ViewName = 'front' | 'back' | 'side' | 'left' | 'top' | 'three_quarter' | 'camera' | 'first_person' | 'head_cam'
export type FittedView = Exclude<ViewName, 'camera' | 'first_person' | 'head_cam'>
export const isFirstPerson = (v: string): v is FirstPersonMode => v === 'first_person' || v === 'head_cam'

const VIEW_DIRS: Record<FittedView, { dir: Vec3; up: Vec3 }> = {
  front: { dir: [0, 0.08, -1], up: [0, 1, 0] },
  back: { dir: [0, 0.08, 1], up: [0, 1, 0] },
  side: { dir: [1, 0.08, 0], up: [0, 1, 0] },
  left: { dir: [-1, 0.08, 0], up: [0, 1, 0] },
  top: { dir: [0, 1, 0.0001], up: [0, 0, -1] },
  three_quarter: { dir: [0.75, 0.42, -1], up: [0, 1, 0] }
}

interface BoneVisual {
  bone: string
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  /** current and target highlight, 0..1 */
  hover: number
  hoverTarget: number
  selected: number
  selectedTarget: number
  kind: 'box' | 'joint' | 'stick'
  parent?: string
}

const tmpV = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

/** Three.js objects for one rig: rounded boxes for parts with a size, joints and sticks for bare skeletons, plus an optional glTF mesh. */
export class RigView {
  group = new THREE.Group()
  visuals: BoneVisual[] = []
  pickables: THREE.Object3D[] = []
  handles = new Map<string, THREE.Mesh>()
  private sideTint = false
  private colors: StageColors
  private gltfNodes = new Map<string, THREE.Object3D>()
  private gltfRoot: THREE.Object3D | null = null
  private body: THREE.Color
  private accent: THREE.Color
  signature: string

  constructor(public rig: Rig, colors: StageColors, readFile?: (path: string) => Promise<Uint8Array>) {
    this.signature = RigView.sign(rig)
    this.colors = colors
    this.body = new THREE.Color(colors.body)
    this.accent = new THREE.Color(colors.accent)
    const rest = computeWorld(rig, {})
    const b = rigBounds(rig, rest)
    const height = Math.max(0.01, b.max[1] - b.min[1])
    const hasShapes = rig.bones.some((x) => x.shape)
    for (const bone of rig.bones) {
      if (bone.shape) {
        const s = bone.shape.size
        const r = Math.min(s[0], s[1], s[2]) * 0.16
        const geo = new RoundedBoxGeometry(s[0], s[1], s[2], 3, r)
        if (bone.shape.offset) geo.translate(...bone.shape.offset)
        this.addVisual(bone.name, geo, 'box')
      } else if (!hasShapes || bone.kind === 'bone') {
        if (bone.locked && rig.bones.length > 1) continue
        const geo = new THREE.SphereGeometry(height * 0.012, 12, 8)
        this.addVisual(bone.name, geo, 'joint')
        if (bone.parent) {
          const stick = new THREE.CylinderGeometry(height * 0.004, height * 0.009, 1, 6)
          stick.translate(0, 0.5, 0)
          this.addVisual(bone.name, stick, 'stick', bone.parent)
        }
      }
    }
    // IK handles: small accent rings at each effector, shown for the active rig.
    for (const chain of rig.chains) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(height * 0.022, 16, 12),
        new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0.9, depthTest: false })
      )
      m.renderOrder = 10
      m.userData.chain = chain.name
      m.visible = false
      this.handles.set(chain.name, m)
      this.group.add(m)
    }
    if (rig.mesh?.path && readFile) void this.loadMesh(rig, readFile)
  }

  static sign(rig: Rig): string {
    return `${rig.id}|${rig.bones.length}|${rig.source}|${rig.mesh?.path ?? ''}|${rig.bones.map((b) => b.name + (b.shape ? b.shape.size.join(',') : '')).join(';')}`
  }

  private addVisual(bone: string, geo: THREE.BufferGeometry, kind: BoneVisual['kind'], parent?: string): void {
    const material = new THREE.MeshStandardMaterial({ color: this.body, roughness: 0.82, metalness: 0, emissive: this.accent, emissiveIntensity: 0 })
    const mesh = new THREE.Mesh(geo, material)
    mesh.castShadow = kind === 'box'
    mesh.receiveShadow = kind === 'box'
    mesh.userData.bone = bone
    if (kind !== 'box') {
      material.depthTest = false
      material.transparent = true
      mesh.renderOrder = 5
    }
    this.group.add(mesh)
    if (kind !== 'stick') this.pickables.push(mesh)
    this.visuals.push({ bone, mesh, material, hover: 0, hoverTarget: 0, selected: 0, selectedTarget: 0, kind, parent })
  }

  private async loadMesh(rig: Rig, readFile: (path: string) => Promise<Uint8Array>): Promise<void> {
    try {
      const bytes = await readFile(rig.mesh!.path)
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const gltf = await new GLTFLoader().parseAsync(buf, '')
      const info = (rig.meta?.gltfNodes ?? {}) as Record<string, { index: number }>
      for (const name in info) {
        const node = (await gltf.parser.getDependency('node', info[name].index)) as THREE.Object3D
        if (node) this.gltfNodes.set(name, node)
      }
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = true
          m.frustumCulled = false
        }
      })
      this.gltfRoot = gltf.scene
      this.gltfRoot.position.set(...rig.origin.p)
      this.gltfRoot.quaternion.set(...rig.origin.q)
      this.group.add(this.gltfRoot)
      this.lastPose && this.applyGltf(this.lastPose)
    } catch (err) {
      console.warn('Could not load rig mesh; showing the skeleton only.', err)
    }
  }

  private lastPose: Pose | null = null

  private applyGltf(pose: Pose): void {
    const info = (this.rig.meta?.gltfNodes ?? {}) as Record<string, { t: Vec3; r: [number, number, number, number]; parentScale: number }>
    const q = new THREE.Quaternion(), r = new THREE.Quaternion()
    for (const [name, node] of this.gltfNodes) {
      const n = info[name]
      const t = pose[name]
      r.set(...n.r)
      if (t) node.quaternion.copy(r).multiply(q.set(...t.q))
      else node.quaternion.copy(r)
      node.position.set(...n.t)
      if (t?.p) node.position.add(tmpV.set(...t.p).applyQuaternion(r).multiplyScalar(1 / (n.parentScale || 1)))
    }
  }

  apply(pose: Pose, world: WorldPose): void {
    this.lastPose = pose
    for (const v of this.visuals) {
      if (v.kind === 'box') {
        const w = world.bone[v.bone]
        v.mesh.position.set(...w.p)
        v.mesh.quaternion.set(...w.q)
      } else if (v.kind === 'joint') {
        v.mesh.position.set(...world.bone[v.bone].p)
      } else {
        const a = world.bone[v.parent!].p, b = world.bone[v.bone].p
        tmpV.set(...a)
        tmpV2.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        const len = tmpV2.length()
        v.mesh.position.copy(tmpV)
        v.mesh.scale.set(1, Math.max(len, 1e-5), 1)
        if (len > 1e-6) v.mesh.quaternion.setFromUnitVectors(UP, tmpV2.multiplyScalar(1 / len))
      }
    }
    for (const chain of this.rig.chains) this.handles.get(chain.name)!.position.set(...effectorWorld(this.rig, world, chain))
    if (this.gltfRoot) this.applyGltf(pose)
  }

  /** Hide one bone's geometry (the head, in first person). */
  setBoneHidden(bone: string | null): void {
    for (const v of this.visuals) v.mesh.visible = v.bone !== bone
    const node = bone ? this.gltfNodes.get(bone) : null
    if (this.gltfRoot) this.gltfRoot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) o.visible = true
    })
    node?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) o.visible = false
    })
  }

  setHover(bone: string | null): void {
    for (const v of this.visuals) v.hoverTarget = bone && v.bone === bone ? 1 : 0
  }
  setSelected(bone: string | null): void {
    for (const v of this.visuals) v.selectedTarget = bone && v.bone === bone ? 1 : 0
  }
  showHandles(on: boolean, activeChain: string | null = null): void {
    for (const [name, m] of this.handles) {
      m.visible = on
      ;(m.material as THREE.MeshBasicMaterial).opacity = name === activeChain ? 1 : 0.55
      m.scale.setScalar(name === activeChain ? 1.35 : 1)
    }
  }

  /** Ease highlights toward their targets. Returns true while something is still animating. */
  tick(dt: number, instant: boolean): boolean {
    let busy = false
    const k = instant ? 1 : 1 - Math.exp(-dt * 16)
    for (const v of this.visuals) {
      if (v.hover !== v.hoverTarget || v.selected !== v.selectedTarget) {
        v.hover += (v.hoverTarget - v.hover) * k
        v.selected += (v.selectedTarget - v.selected) * k
        if (Math.abs(v.hover - v.hoverTarget) < 0.004) v.hover = v.hoverTarget
        if (Math.abs(v.selected - v.selectedTarget) < 0.004) v.selected = v.selectedTarget
        else busy = true
        if (v.hover !== v.hoverTarget) busy = true
        v.material.emissiveIntensity = Math.min(0.75, v.hover * 0.22 + v.selected * 0.6)
        if (v.kind !== 'box') v.material.opacity = 0.75 + 0.25 * Math.max(v.hover, v.selected)
      }
    }
    return busy
  }

  private baseColor(bone: string): THREE.ColorRepresentation {
    if (!this.sideTint) return this.body
    const side = /right/i.test(bone) ? this.colors.bodyRight : /left/i.test(bone) ? this.colors.bodyLeft : null
    const c = new THREE.Color(side ?? this.body)
    // Alternate the shade along a limb so upper, lower and end segments read apart even when straight.
    if (/lower|fore|calf|shin/i.test(bone)) c.multiplyScalar(0.84)
    else if (/hand|foot/i.test(bone)) c.multiplyScalar(0.66)
    else if (!side && /lowertorso|hips|pelvis/i.test(bone)) c.multiplyScalar(0.84)
    else if (!side && /head/i.test(bone)) c.multiplyScalar(0.92)
    return c
  }

  /** Preview mode: tint right limbs warm and left limbs cool, with a different shade per segment. */
  setPreviewStyle(on: boolean): void {
    this.sideTint = on
    for (const v of this.visuals) v.material.color.set(this.baseColor(v.bone))
  }

  /** Flat translucent tint for onion skins; null restores normal shading. */
  setGhost(color: string | null, opacity = 0.3): void {
    for (const v of this.visuals) {
      v.material.transparent = !!color || v.kind !== 'box'
      v.material.opacity = color ? opacity : 1
      v.material.color.set(color ?? this.baseColor(v.bone))
      v.material.depthWrite = !color
      v.mesh.castShadow = !color && v.kind === 'box'
    }
    for (const h of this.handles.values()) if (color) h.visible = false
  }

  setColors(colors: StageColors): void {
    this.colors = colors
    this.body.set(colors.body)
    this.accent.set(colors.accent)
    for (const v of this.visuals) {
      v.material.color.set(this.baseColor(v.bone))
      v.material.emissive.copy(this.accent)
    }
    for (const h of this.handles.values()) (h.material as THREE.MeshBasicMaterial).color.copy(this.accent)
  }

  dispose(): void {
    for (const v of this.visuals) {
      v.mesh.geometry.dispose()
      v.material.dispose()
    }
    for (const h of this.handles.values()) {
      h.geometry.dispose()
      ;(h.material as THREE.Material).dispose()
    }
  }
}

const GRID_VERT = `varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`
const GRID_FRAG = `
varying vec3 vWorld; uniform vec3 uGround; uniform vec3 uLine; uniform float uRadius; uniform float uAlpha;
float line(float c, float w){ float d = abs(fract(c - 0.5) - 0.5) / fwidth(c); return 1.0 - min(d / w, 1.0); }
void main(){
  float minor = max(line(vWorld.x, 1.0), line(vWorld.z, 1.0));
  float major = max(line(vWorld.x / 5.0, 1.4), line(vWorld.z / 5.0, 1.4));
  float fade = 1.0 - smoothstep(uRadius * 0.35, uRadius, length(vWorld.xz));
  vec3 col = mix(uGround, uLine, max(minor * 0.45, major * 0.9));
  gl_FragColor = vec4(col, fade * uAlpha);
  #include <colorspace_fragment>
}`

/** A scene with rigs, a 1-unit ground grid and lights. Renderers and cameras are supplied by callers. */
export class Stage {
  scene = new THREE.Scene()
  views = new Map<string, RigView>()
  colors: StageColors
  private ground: THREE.Mesh
  private shadowCatcher: THREE.Mesh
  private gridMat: THREE.ShaderMaterial
  private key: THREE.DirectionalLight
  private overlay = new THREE.Group()
  project: Project | null = null

  constructor(colors: StageColors, private readFile?: (path: string) => Promise<Uint8Array>) {
    this.colors = colors
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f9c, 1.15))
    this.key = new THREE.DirectionalLight(0xffffff, 1.9)
    this.key.position.set(6, 14, -9)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.bias = -0.0005
    this.key.shadow.normalBias = 0.03
    const sc = this.key.shadow.camera
    sc.left = -14
    sc.right = 14
    sc.top = 14
    sc.bottom = -14
    sc.near = 0.5
    sc.far = 60
    this.scene.add(this.key, this.key.target)
    const fill = new THREE.DirectionalLight(0xffffff, 0.5)
    fill.position.set(-8, 5, 7)
    this.scene.add(fill)

    this.gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, transparent: true, depthWrite: false,
      uniforms: { uGround: { value: new THREE.Color() }, uLine: { value: new THREE.Color() }, uRadius: { value: 60 }, uAlpha: { value: 1 } }
    })
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.gridMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.renderOrder = -2
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.ShadowMaterial({ opacity: 0.2 }))
    this.shadowCatcher.rotation.x = -Math.PI / 2
    this.shadowCatcher.position.y = 0.001
    this.shadowCatcher.receiveShadow = true
    this.shadowCatcher.renderOrder = -1
    this.scene.add(this.ground, this.shadowCatcher, this.overlay)
    this.setColors(colors)
  }

  setColors(colors: StageColors): void {
    this.colors = colors
    this.gridMat.uniforms.uGround.value.set(colors.ground)
    this.gridMat.uniforms.uLine.value.set(colors.grid)
    ;(this.shadowCatcher.material as THREE.ShadowMaterial).opacity = colors === THEMES.dark ? 0.35 : 0.16
    for (const v of this.views.values()) v.setColors(colors)
  }

  setGroundVisible(on: boolean): void {
    this.ground.visible = on
    this.shadowCatcher.visible = on
  }

  setProject(project: Project): void {
    this.project = project
    const seen = new Set<string>()
    for (const rig of project.rigs) {
      seen.add(rig.id)
      const existing = this.views.get(rig.id)
      if (existing && existing.signature === RigView.sign(rig)) {
        existing.rig = rig
        continue
      }
      if (existing) {
        this.scene.remove(existing.group)
        existing.dispose()
      }
      const view = new RigView(rig, this.colors, this.readFile)
      if (this.previewStyle) view.setPreviewStyle(true)
      this.views.set(rig.id, view)
      this.scene.add(view.group)
    }
    for (const [id, v] of this.views) if (!seen.has(id)) {
      this.scene.remove(v.group)
      v.dispose()
      this.views.delete(id)
    }
  }

  /** Pose every rig at a frame. `override` replaces the evaluated pose for one rig (live gizmo drags). */
  applyFrame(clip: Clip | undefined, frame: number, override?: { rigId: string; pose: Pose }): void {
    if (!this.project) return
    for (const rig of this.project.rigs) {
      const view = this.views.get(rig.id)
      if (!view) continue
      const pose = override?.rigId === rig.id ? override.pose : clip ? evaluateRig(clip, rig, frame) : {}
      view.apply(pose, computeWorld(rig, pose))
    }
  }

  setPreviewStyle(on: boolean): void {
    this.previewStyle = on
    for (const v of this.views.values()) v.setPreviewStyle(on)
  }
  private previewStyle = false

  setVisibleRigs(ids: string[] | null): void {
    for (const [id, v] of this.views) v.group.visible = !ids || ids.includes(id)
  }

  /** Bounds of the visible rigs over a set of frames (scene space). */
  boundsOver(clip: Clip | undefined, frames: number[], rigIds?: string[]): THREE.Box3 {
    const box = new THREE.Box3()
    if (!this.project) return box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 5, 2))
    for (const rig of this.project.rigs) {
      if (rigIds && !rigIds.includes(rig.id)) continue
      for (const f of frames.length ? frames : [0]) {
        const b = rigBounds(rig, computeWorld(rig, clip ? evaluateRig(clip, rig, f) : {}))
        box.expandByPoint(tmpV.set(...b.min))
        box.expandByPoint(tmpV.set(...b.max))
      }
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 5, 2))
    box.expandByPoint(tmpV.set(box.min.x, Math.min(0, box.min.y), box.min.z))
    return box
  }

  /** Place a camera for a named view so `box` fits the frame. */
  frameCamera(camera: THREE.PerspectiveCamera, view: FittedView, box: THREE.Box3, margin = 1.18): void {
    const v = VIEW_DIRS[view]
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const dir = new THREE.Vector3(...v.dir).normalize()
    camera.up.set(...v.up)
    // Fit the box's silhouette extents for this direction.
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize()
    const up = new THREE.Vector3().crossVectors(right, dir).normalize()
    const halfW = (Math.abs(right.x) * size.x + Math.abs(right.y) * size.y + Math.abs(right.z) * size.z) / 2
    const halfH = (Math.abs(up.x) * size.x + Math.abs(up.y) * size.y + Math.abs(up.z) * size.z) / 2
    const depth = (Math.abs(dir.x) * size.x + Math.abs(dir.y) * size.y + Math.abs(dir.z) * size.z) / 2
    const tanV = Math.tan((camera.fov * Math.PI) / 360)
    const dist = Math.max(halfH / tanV, halfW / (tanV * camera.aspect)) * margin + depth
    camera.position.copy(center).addScaledVector(dir, dist)
    camera.near = Math.max(0.05, dist / 200)
    camera.far = dist * 20 + 200
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    this.gridMat.uniforms.uRadius.value = Math.max(30, dist * 4)
  }

  /**
   * Look through a rig's eyes at a frame (the rig must already be posed with applyFrame).
   * Hides that rig's head; call clearFirstPerson() afterwards.
   */
  eyeCamera(camera: THREE.PerspectiveCamera, rigId: string, clip: Clip | undefined, frame: number, mode: FirstPersonMode, pose?: Pose): void {
    const rig = this.project?.rigs.find((r) => r.id === rigId)
    if (!rig) throw new Error('No rig for the first-person view.')
    const world = computeWorld(rig, pose ?? (clip ? evaluateRig(clip, rig, frame) : {}))
    const eye = firstPersonCamera(rig, world, mode)
    camera.fov = eye.fov
    camera.up.set(...eye.up)
    camera.position.set(...eye.position)
    const span = Math.max(1, rigBounds(rig, world).max[1] - rigBounds(rig, world).min[1])
    camera.near = span * 0.012
    camera.far = 2000
    camera.lookAt(eye.position[0] + eye.forward[0], eye.position[1] + eye.forward[1], eye.position[2] + eye.forward[2])
    camera.updateProjectionMatrix()
    this.gridMat.uniforms.uRadius.value = 60
    for (const [id, v] of this.views) v.setBoneHidden(id === rigId ? rig.head ?? null : null)
  }

  clearFirstPerson(): void {
    for (const v of this.views.values()) v.setBoneHidden(null)
  }

  /** Aim a camera from the clip's camera track. Returns false when the clip has no camera keys. */
  trackCamera(camera: THREE.PerspectiveCamera, clip: Clip, frame: number): boolean {
    const c = sampleCamera(clip.camera, frame)
    if (!c) return false
    camera.up.set(0, 1, 0)
    camera.fov = c.fov
    camera.position.set(...c.position)
    camera.near = 0.05
    camera.far = 2000
    camera.lookAt(...c.target)
    camera.updateProjectionMatrix()
    return true
  }

  setGhost(color: string | null, opacity?: number): void {
    for (const v of this.views.values()) v.setGhost(color, opacity)
  }

  clearOverlay(): void {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c)
      const o = c as THREE.Line
      o.geometry?.dispose()
      ;(o.material as THREE.Material | undefined)?.dispose()
    }
  }

  /** Draw motion trails (path over the whole clip, a dot per frame) for chain or bone names. */
  addTrails(clip: Clip, names: string[], rigIds: string[]): string[] {
    const unknown: string[] = []
    if (!this.project) return names
    for (const name of names) {
      let found = false
      for (const rig of this.project.rigs) {
        if (!rigIds.includes(rig.id)) continue
        const chain = rig.chains.find((c) => c.name === name)
        const bone = rig.bones.find((b) => b.name === name)
        if (!chain && !bone) continue
        found = true
        const pts: number[] = []
        for (let f = 0; f <= clip.length; f++) {
          const w = computeWorld(rig, evaluateRig(clip, rig, f))
          const p = chain ? effectorWorld(rig, w, chain) : w.bone[bone!.name].p
          pts.push(p[0], p[1], p[2])
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: this.colors.accent, depthTest: false, transparent: true, opacity: 0.9 }))
        line.renderOrder = 20
        const dots = new THREE.Points(geo.clone(), new THREE.PointsMaterial({ color: this.colors.accent, size: 5, sizeAttenuation: false, depthTest: false }))
        dots.renderOrder = 21
        this.overlay.add(line, dots)
      }
      if (!found) unknown.push(name)
    }
    return unknown
  }

  /** Camera frustum marker for the cutscene camera, shown in the editing viewport. */
  setCameraMarker(clip: Clip | undefined, frame: number): void {
    const existing = this.overlay.getObjectByName('cameraMarker')
    const c = clip ? sampleCamera(clip.camera, frame) : undefined
    if (!c) {
      if (existing) this.overlay.remove(existing)
      return
    }
    let g = existing as THREE.Group | undefined
    if (!g) {
      g = new THREE.Group()
      g.name = 'cameraMarker'
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.7), new THREE.MeshStandardMaterial({ color: this.colors.accent, roughness: 0.6 }))
      const lens = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.4, 4), new THREE.MeshStandardMaterial({ color: this.colors.accent, roughness: 0.6 }))
      lens.rotation.x = Math.PI / 2
      lens.rotation.y = Math.PI / 4
      lens.position.z = -0.5
      g.add(body, lens)
      this.overlay.add(g)
    }
    g.position.set(...c.position)
    g.lookAt(...c.target)
    // lookAt points +Z at the target for non-camera objects; the marker's lens is on -Z.
    g.rotateY(Math.PI)
  }

  dispose(): void {
    for (const v of this.views.values()) v.dispose()
    this.clearOverlay()
    this.ground.geometry.dispose()
    this.gridMat.dispose()
  }
}
