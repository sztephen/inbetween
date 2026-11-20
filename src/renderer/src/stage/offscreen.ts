import * as THREE from 'three'
import { getClip } from '@core/clip'
import type { PreviewRequest, VideoRequest } from '@core/tools/registry'
import { isFirstPerson, Stage, THEMES, type FittedView, type StageColors } from './Stage'

// Off-screen rendering for the AI's `preview` tool and for video export. Uses its own scene so
// the editing viewport is never disturbed, and its own WebGL canvas that is never attached to the page.

let renderer: THREE.WebGLRenderer | null = null
let canvas: HTMLCanvasElement | null = null

function getRenderer(width: number, height: number): THREE.WebGLRenderer {
  if (!renderer) {
    canvas = document.createElement('canvas')
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: false })
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
  }
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  return renderer
}

const VIEW_LABEL: Record<string, string> = { front: 'front', back: 'back', side: 'right side', left: 'left side', top: 'top', three_quarter: '3/4', camera: 'camera', first_person: 'first-person', head_cam: 'head camera (first-person, follows the head)' }
const WIDE = (v: string): boolean => isFirstPerson(v) || v === 'camera'

/** Contact sheet: one cell per frame per view, labelled, over the ground grid. Returns a PNG data URL. */
export async function renderContactSheet(req: PreviewRequest, colors: StageColors, readFile: (p: string) => Promise<Uint8Array>): Promise<string> {
  const clip = getClip(req.project, req.clipId)
  const cell = req.cellSize
  const gl = getRenderer(cell, cell)
  const stage = new Stage(colors, readFile)
  try {
    stage.setPreviewStyle(true)
    stage.setProject(req.project)
    stage.setVisibleRigs(req.rigIds)
    // Give any glTF meshes a moment to load so they are in the picture.
    if (req.project.rigs.some((r) => r.mesh)) await new Promise((r) => setTimeout(r, 350))
    const unknownTrails = req.trails.length ? stage.addTrails(clip, req.trails, req.rigIds) : []
    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 500)
    // One fixed camera per view, fitted to the whole range shown, so travel reads correctly from cell to cell.
    const span: number[] = []
    const lo = Math.min(...req.frames), hi = Math.max(...req.frames)
    for (let f = lo; f <= hi; f += Math.max(1, Math.floor((hi - lo) / 24))) span.push(f)
    span.push(hi)
    const box = stage.boundsOver(clip, span, req.rigIds)

    const cols = Math.min(req.frames.length, cell >= 384 ? 4 : cell >= 300 ? 5 : 6)
    const rowsPerView = Math.ceil(req.frames.length / cols)
    const gap = 6, header = 26
    const sheet = document.createElement('canvas')
    sheet.width = cols * cell + (cols + 1) * gap
    // First-person and cutscene-camera cells are 16:9, the rest are square.
    const cellH = (v: string): number => (WIDE(v) ? Math.round((cell * 9) / 16) : cell)
    sheet.height = req.views.reduce((h, v) => h + rowsPerView * (cellH(v) + gap) + header, 0) + gap
    const ctx = sheet.getContext('2d')!
    ctx.fillStyle = colors === THEMES.dark ? '#111318' : '#cfd2da'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    ctx.textBaseline = 'middle'
    const legend = `right limbs are tinted red, left limbs blue, hands and feet darkest${req.onionSkin ? '; ghosts: red = previous shown frame, blue = next' : ''}${req.trails.length ? '; blue line = motion trail, one dot per frame' : ''}; grid squares are 1 unit`

    gl.setClearColor(new THREE.Color(colors.background), 1)
    let y = gap
    for (const view of req.views) {
      ctx.fillStyle = colors.label
      ctx.font = '600 15px system-ui, sans-serif'
      ctx.fillText(`${VIEW_LABEL[view] ?? view} view`, gap + 4, y + header / 2)
      if (view === req.views[0]) {
        ctx.font = '13px system-ui, sans-serif'
        ctx.globalAlpha = 0.7
        ctx.textAlign = 'right'
        ctx.fillText(legend, sheet.width - gap - 4, y + header / 2)
        ctx.textAlign = 'left'
        ctx.globalAlpha = 1
        ctx.font = '600 15px system-ui, sans-serif'
      }
      if (view === 'side' || view === 'left' || view === 'top') {
        ctx.font = '13px system-ui, sans-serif'
        ctx.globalAlpha = 0.7
        ctx.fillText(view === 'side' ? 'character faces right →' : view === 'left' ? '← character faces left' : 'character faces up ↑', gap + 150, y + header / 2)
        ctx.globalAlpha = 1
      }
      y += header
      const ch = cellH(view)
      gl.setSize(cell, ch, false)
      camera.aspect = cell / ch
      camera.fov = 26
      const fp = isFirstPerson(view)
      if (fp && !req.subjectRigId) throw new Error('First-person views need a subject rig.')
      if (!fp) stage.clearFirstPerson()
      if (view !== 'camera' && !fp) stage.frameCamera(camera, view as FittedView, box)
      req.frames.forEach((frame, i) => {
        const cx = gap + (i % cols) * (cell + gap)
        const cy = y + Math.floor(i / cols) * (ch + gap)
        if (view === 'camera') stage.trackCamera(camera, clip, frame)
        else if (fp) stage.eyeCamera(camera, req.subjectRigId!, clip, frame, view)
        gl.autoClear = true
        if (req.onionSkin) {
          // Ghost the neighbouring sampled frames first, then draw the real pose over them.
          const prev = req.frames[i - 1], next = req.frames[i + 1]
          gl.clear()
          gl.autoClear = false
          for (const [f, tint] of [[prev, colors.ghostPrev], [next, colors.ghostNext]] as [number | undefined, string][]) {
            if (f === undefined) continue
            stage.applyFrame(clip, f)
            stage.setGhost(tint, 0.26)
            gl.render(stage.scene, camera)
            gl.clearDepth()
          }
          stage.setGhost(null)
        }
        stage.applyFrame(clip, frame)
        gl.render(stage.scene, camera)
        gl.autoClear = true
        ctx.drawImage(gl.domElement, cx, cy, cell, ch)
        // Frame label on a solid chip so it is readable over anything.
        const label = `f${frame}`
        ctx.font = '600 17px system-ui, sans-serif'
        const w = ctx.measureText(label).width + 14
        ctx.fillStyle = colors === THEMES.dark ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.86)'
        ctx.fillRect(cx + 6, cy + 6, w, 24)
        ctx.fillStyle = colors.label
        ctx.fillText(label, cx + 13, cy + 19)
      })
      y += rowsPerView * (ch + gap)
    }
    if (unknownTrails.length) {
      ctx.fillStyle = colors.ghostPrev
      ctx.font = '13px system-ui, sans-serif'
      ctx.fillText(`no trail drawn for unknown name(s): ${unknownTrails.join(', ')}`, gap + 4, sheet.height - 10)
    }
    return sheet.toDataURL('image/png')
  } finally {
    stage.dispose()
  }
}

// ---------------------------------------------------------------- video

let video: { stage: Stage; camera: THREE.PerspectiveCamera; req: VideoRequest; gl: THREE.WebGLRenderer; buf: Uint8Array; out: Uint8Array } | null = null

export async function videoBegin(req: VideoRequest, themeColors: StageColors, readFile: (p: string) => Promise<Uint8Array>): Promise<void> {
  videoEnd()
  const clip = getClip(req.project, req.clipId)
  const transparent = req.background === 'transparent'
  const colors: StageColors = transparent || req.background === 'theme' || !/^#[0-9a-f]{6}$/i.test(req.background)
    ? themeColors
    : { ...themeColors, background: req.background, ground: req.background }
  const gl = getRenderer(req.width, req.height)
  const stage = new Stage(colors, readFile)
  stage.setProject(req.project)
  if (req.project.rigs.some((r) => r.mesh)) await new Promise((r) => setTimeout(r, 350))
  if (transparent) stage.setGroundVisible(false)
  gl.setClearColor(new THREE.Color(colors.background), transparent ? 0 : 1)
  const camera = new THREE.PerspectiveCamera(30, req.width / req.height, 0.1, 500)
  if (req.camera !== 'track' && !isFirstPerson(req.camera)) {
    const frames: number[] = []
    for (let f = 0; f <= clip.length; f += Math.max(1, Math.floor(clip.length / 30))) frames.push(f)
    frames.push(clip.length)
    stage.frameCamera(camera, req.camera as FittedView, stage.boundsOver(clip, frames), 1.25)
  }
  const size = req.width * req.height * 4
  video = { stage, camera, req, gl, buf: new Uint8Array(size), out: new Uint8Array(size) }
}

/** Render one video frame at a time in seconds; returns top-down RGBA bytes. */
export function videoFrame(time: number): Uint8Array {
  if (!video) throw new Error('Video export was not started.')
  const { stage, camera, req, gl, buf, out } = video
  const clip = getClip(req.project, req.clipId)
  const frame = Math.min(clip.length, time * clip.fps)
  if (req.camera === 'track' && !stage.trackCamera(camera, clip, frame)) throw new Error('This clip has no camera keys; choose another camera for the video.')
  camera.aspect = req.width / req.height
  camera.updateProjectionMatrix()
  stage.applyFrame(clip, frame)
  if (isFirstPerson(req.camera)) {
    const rigId = req.rigId ?? req.project.activeRigId ?? req.project.rigs[0]?.id
    if (!rigId) throw new Error('No rig for the first-person camera.')
    stage.eyeCamera(camera, rigId, clip, frame, req.camera)
  }
  gl.render(stage.scene, camera)
  const ctx = gl.getContext()
  ctx.readPixels(0, 0, req.width, req.height, ctx.RGBA, ctx.UNSIGNED_BYTE, buf)
  // WebGL rows are bottom-up; video wants top-down.
  const row = req.width * 4
  for (let y = 0; y < req.height; y++) out.set(buf.subarray((req.height - 1 - y) * row, (req.height - y) * row), y * row)
  return out.slice()
}

export function videoEnd(): void {
  video?.stage.dispose()
  video = null
}
