import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { evaluateRig } from '@core/clip'
import { solveChain } from '@core/ik'
import { qinv, qmul, qnorm, qrot, vsub, type Quat, type Vec3 } from '@core/math'
import { computeWorld, effectorWorld, getBone } from '@core/rig'
import type { Pose } from '@core/types'
import { Stage, THEMES } from '../stage/Stage'
import { activeClip, activeRig, api, command, reducedMotion, useStore } from '../store'

/** Imperative handle so menus and shortcuts can act on the viewport. */
export const viewportActions: { frameRig?: () => void } = {}

export function Viewport(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)

    const stage = new Stage(THEMES[useStore.getState().resolvedTheme], (p) => api.readFile(p))
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 2000)
    const eyeCam = new THREE.PerspectiveCamera(70, 1, 0.05, 2000)
    camera.position.set(7, 5.2, -11)
    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.set(0, 2.7, 0)
    orbit.enableDamping = !reducedMotion()
    orbit.dampingFactor = 0.12
    orbit.rotateSpeed = 0.9
    orbit.maxPolarAngle = Math.PI * 0.52
    orbit.minDistance = 1
    orbit.maxDistance = 400
    orbit.update()

    const gizmo = new TransformControls(camera, renderer.domElement)
    gizmo.setSize(0.85)
    const gizmoHelper = gizmo.getHelper()
    stage.scene.add(gizmoHelper)
    const proxy = new THREE.Object3D()
    stage.scene.add(proxy)

    let dirty = true
    let dragging = false
    let draft: { rigId: string; pose: Pose } | null = null
    let pendingCommit = false
    let last = performance.now()
    let raf = 0
    let flight: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    const invalidate = (): void => {
      dirty = true
    }

    const resize = (): void => {
      const w = host.clientWidth, h = host.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      eyeCam.aspect = w / h
      invalidate()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    // ---- gizmo <-> pose

    const currentPose = (): { pose: Pose; rigId: string } | null => {
      const s = useStore.getState()
      const rig = activeRig(s), clip = activeClip(s)
      if (!rig) return null
      return { rigId: rig.id, pose: draft?.rigId === rig.id ? draft.pose : clip ? evaluateRig(clip, rig, Math.round(s.frame)) : {} }
    }

    /** Put the gizmo on the selected bone's pivot or the selected chain's effector. */
    const syncGizmo = (): void => {
      const s = useStore.getState()
      const rig = activeRig(s)
      const cur = currentPose()
      if (!rig || !cur || (!s.selectedBone && !s.selectedChain) || s.playing || s.firstPerson) {
        if (gizmo.object) gizmo.detach()
        return
      }
      const world = computeWorld(rig, cur.pose)
      if (s.selectedChain) {
        const chain = rig.chains.find((c) => c.name === s.selectedChain)
        if (!chain) return void gizmo.detach()
        proxy.position.set(...effectorWorld(rig, world, chain))
        proxy.quaternion.identity()
        gizmo.setMode('translate')
        gizmo.setSpace('world')
      } else {
        const bone = rig.bones.find((b) => b.name === s.selectedBone)
        if (!bone || bone.locked) return void gizmo.detach()
        const J = world.joint[bone.name]
        const T = cur.pose[bone.name] ?? { q: [0, 0, 0, 1] as Quat }
        const move = s.gizmo === 'move' && bone.translatable
        const jq = qmul(J.q, T.q)
        const jp = T.p ? ([J.p[0] + qrot(J.q, T.p)[0], J.p[1] + qrot(J.q, T.p)[1], J.p[2] + qrot(J.q, T.p)[2]] as Vec3) : J.p
        proxy.position.set(...jp)
        proxy.quaternion.set(...jq)
        gizmo.setMode(move ? 'translate' : 'rotate')
        gizmo.setSpace(move ? 'world' : 'local')
      }
      if (gizmo.object !== proxy) gizmo.attach(proxy)
    }

    const onGizmoChange = (): void => {
      if (!dragging) return
      const s = useStore.getState()
      const rig = activeRig(s), clip = activeClip(s)
      if (!rig || !clip) return
      const frame = Math.round(s.frame)
      const pose = evaluateRig(clip, rig, frame)
      if (s.selectedChain) {
        const chain = rig.chains.find((c) => c.name === s.selectedChain)
        if (!chain) return
        solveChain(rig, pose, chain, { position: proxy.position.toArray() as Vec3 })
      } else if (s.selectedBone) {
        const bone = getBone(rig, s.selectedBone)
        const J = computeWorld(rig, pose).joint[bone.name]
        const prev = pose[bone.name] ?? { q: [0, 0, 0, 1] as Quat }
        if (gizmo.getMode() === 'translate') {
          pose[bone.name] = { q: prev.q, p: qrot(qinv(J.q), vsub(proxy.position.toArray() as Vec3, J.p)) }
        } else {
          pose[bone.name] = { q: qnorm(qmul(qinv(J.q), proxy.quaternion.toArray() as Quat)), p: prev.p }
        }
      }
      draft = { rigId: rig.id, pose }
      invalidate()
    }
    gizmo.addEventListener('objectChange', onGizmoChange)
    gizmo.addEventListener('change', invalidate)
    gizmo.addEventListener('dragging-changed', (e) => {
      dragging = !!(e as unknown as { value: boolean }).value
      orbit.enabled = !dragging
      if (dragging || !draft) return
      // Commit the drag as one undoable edit; keep showing the draft until the document echoes back.
      const s = useStore.getState()
      const frame = Math.round(s.frame)
      const rig = activeRig(s)
      if (!rig) return
      pendingCommit = true
      if (s.selectedChain) void command({ type: 'dragIK', frame, chain: s.selectedChain, position: proxy.position.toArray() as Vec3 })
      else if (s.selectedBone) {
        const t = draft.pose[s.selectedBone]
        void command({ type: 'setBone', frame, bone: s.selectedBone, q: t.q, p: t.p })
      }
    })

    // ---- picking

    const pick = (ev: PointerEvent): { bone?: string; chain?: string; rigId?: string } => {
      const r = renderer.domElement.getBoundingClientRect()
      pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
      const s = useStore.getState()
      const rig = activeRig(s)
      if (rig) {
        const view = stage.views.get(rig.id)
        const handles = view ? [...view.handles.values()].filter((h) => h.visible) : []
        const hit = raycaster.intersectObjects(handles, false)[0]
        if (hit) return { chain: hit.object.userData.chain as string, rigId: rig.id }
      }
      let best: { bone: string; rigId: string; d: number } | null = null
      for (const [rigId, view] of stage.views) {
        if (!view.group.visible) continue
        const hit = raycaster.intersectObjects(view.pickables, false)[0]
        if (hit && (!best || hit.distance < best.d)) best = { bone: hit.object.userData.bone as string, rigId, d: hit.distance }
      }
      return best ? { bone: best.bone, rigId: best.rigId } : {}
    }

    let down: { x: number; y: number } | null = null
    let hoverBone: string | null = null
    let hoverRig: string | null = null
    const onDown = (ev: PointerEvent): void => {
      down = { x: ev.clientX, y: ev.clientY }
    }
    const onUp = (ev: PointerEvent): void => {
      if (!down || dragging || useStore.getState().firstPerson) return
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y)
      down = null
      if (moved > 4 || ev.button !== 0) return
      const hit = pick(ev)
      const s = useStore.getState()
      if (hit.chain) s.set({ selectedChain: hit.chain, selectedBone: null })
      else if (hit.bone) {
        if (hit.rigId && hit.rigId !== activeRig(s)?.id) void command({ type: 'setActive', rigId: hit.rigId })
        s.set({ selectedBone: hit.bone, selectedChain: null })
      } else s.set({ selectedBone: null, selectedChain: null })
    }
    const onMove = (ev: PointerEvent): void => {
      if (dragging || ev.buttons || useStore.getState().firstPerson) return
      const hit = pick(ev)
      const b = hit.bone ?? null, r = hit.rigId ?? null
      if (b === hoverBone && r === hoverRig) return
      hoverBone = b
      hoverRig = r
      for (const [id, v] of stage.views) v.setHover(id === r ? b : null)
      renderer.domElement.style.cursor = b || hit.chain ? 'pointer' : ''
      invalidate()
    }
    const onLeave = (): void => {
      hoverBone = null
      for (const v of stage.views.values()) v.setHover(null)
      invalidate()
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    orbit.addEventListener('change', invalidate)

    // ---- camera framing

    viewportActions.frameRig = (): void => {
      const s = useStore.getState()
      const rig = activeRig(s)
      const box = stage.boundsOver(activeClip(s), [Math.round(s.frame)], rig ? [rig.id] : undefined)
      const center = box.getCenter(new THREE.Vector3())
      const radius = box.getSize(new THREE.Vector3()).length() / 2
      const dir = camera.position.clone().sub(orbit.target).normalize()
      const dist = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.15
      const to = center.clone().addScaledVector(dir, dist)
      if (reducedMotion()) {
        camera.position.copy(to)
        orbit.target.copy(center)
        orbit.update()
        invalidate()
      } else flight = { from: camera.position.clone(), to, tFrom: orbit.target.clone(), tTo: center, t: 0 }
    }


    // Hooks for the end-to-end test script: where things are on screen.
    const toScreen = (v: THREE.Vector3): { x: number; y: number } => {
      const r = renderer.domElement.getBoundingClientRect()
      const p = v.clone().project(camera)
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }
    }
    ;(window as unknown as { __inbetweenTest: unknown }).__inbetweenTest = {
      project: (bone: string) => {
        const s = useStore.getState()
        const rig = activeRig(s)!
        const w = computeWorld(rig, currentPose()!.pose)
        return toScreen(new THREE.Vector3(...w.bone[bone].p))
      },
      handle: (chain: string) => toScreen(stage.views.get(activeRig(useStore.getState())!.id)!.handles.get(chain)!.position.clone()),
      gizmoHandle: () => {
        const dist = proxy.position.distanceTo(camera.position)
        const scale = (dist * Math.min((1.9 * Math.tan((Math.PI * camera.fov) / 360)) / camera.zoom, 7) * gizmo.size) / 4
        if (gizmo.getMode() === 'translate') return toScreen(proxy.position.clone().add(new THREE.Vector3(0, 0.3 * scale, 0)))
        // A point on the X rotation ring, on the side facing the camera.
        const a = new THREE.Vector3(0, 0.3536, 0.3536).multiplyScalar(scale).applyQuaternion(proxy.quaternion)
        const p1 = proxy.position.clone().add(a), p2 = proxy.position.clone().sub(a)
        return toScreen(p1.distanceTo(camera.position) < p2.distanceTo(camera.position) ? p1 : p2)
      },
      selected: () => useStore.getState().selectedBone,
      setFrame: (frame: number, keys: number[]) => useStore.getState().set({ frame, selectedKeys: keys, playing: false })
    }

    // ---- state sync

    const applySelection = (): void => {
      const s = useStore.getState()
      const rig = activeRig(s)
      for (const [id, v] of stage.views) {
        v.setSelected(id === rig?.id ? s.selectedBone : null)
        v.showHandles(id === rig?.id && !s.playing && !s.firstPerson, s.selectedChain)
      }
      syncGizmo()
      invalidate()
    }

    let lastDoc = useStore.getState().doc
    let lastTheme = useStore.getState().resolvedTheme
    if (lastDoc) stage.setProject(lastDoc.project)
    applySelection()
    const unsub = useStore.subscribe((s, prev) => {
      if (s.doc !== lastDoc) {
        lastDoc = s.doc
        if (s.doc) stage.setProject(s.doc.project)
        if (pendingCommit || !dragging) {
          draft = null
          pendingCommit = false
        }
        // Selections that no longer exist are dropped quietly.
        const rig = activeRig(s)
        if (s.selectedBone && !rig?.bones.some((b) => b.name === s.selectedBone)) s.set({ selectedBone: null })
        if (s.selectedChain && !rig?.chains.some((c) => c.name === s.selectedChain)) s.set({ selectedChain: null })
        applySelection()
      }
      if (s.resolvedTheme !== lastTheme) {
        lastTheme = s.resolvedTheme
        stage.setColors(THEMES[s.resolvedTheme])
        invalidate()
      }
      if (s.selectedBone !== prev.selectedBone || s.selectedChain !== prev.selectedChain || s.gizmo !== prev.gizmo || s.playing !== prev.playing || s.firstPerson !== prev.firstPerson) {
        orbit.enabled = !s.firstPerson
        if (!s.firstPerson) stage.clearFirstPerson()
        applySelection()
      }
      if (s.frame !== prev.frame) {
        if (!dragging) {
          draft = null
          if (!s.playing) syncGizmo()
        }
        invalidate()
      }
    })

    // ---- loop

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const s = useStore.getState()
      const clip = activeClip(s)
      if (s.playing && clip) {
        let f = s.frame + dt * clip.fps * s.speed
        if (f >= clip.length) {
          if (clip.loop) f = clip.length > 0 ? f % clip.length : 0
          else {
            f = clip.length
            s.set({ playing: false })
          }
        }
        s.set({ frame: f })
      }
      if (flight) {
        flight.t = Math.min(1, flight.t + dt / 0.32)
        const e = 1 - Math.pow(1 - flight.t, 3)
        camera.position.lerpVectors(flight.from, flight.to, e)
        orbit.target.lerpVectors(flight.tFrom, flight.tTo, e)
        if (flight.t >= 1) flight = null
        dirty = true
      }
      if (orbit.enableDamping) orbit.update()
      let animating = false
      for (const v of stage.views.values()) animating = v.tick(dt, reducedMotion()) || animating
      if (!dirty && !animating) return
      dirty = false
      const st = useStore.getState()
      stage.applyFrame(activeClip(st), st.playing ? st.frame : Math.round(st.frame), draft ?? undefined)
      stage.setCameraMarker(activeClip(st), st.frame)
      renderer.setClearColor(stage.colors.background, 1)
      const fpRig = st.firstPerson ? activeRig(st) : undefined
      if (fpRig?.head && st.firstPerson) {
        const f = st.playing ? st.frame : Math.round(st.frame)
        stage.eyeCamera(eyeCam, fpRig.id, activeClip(st), f, st.firstPerson, draft?.rigId === fpRig.id ? draft.pose : undefined)
        renderer.render(stage.scene, eyeCam)
      } else renderer.render(stage.scene, camera)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      unsub()
      ro.disconnect()
      viewportActions.frameRig = undefined
      gizmo.detach()
      gizmo.dispose()
      orbit.dispose()
      stage.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={hostRef} className="viewport" aria-label="3D viewport" />
}
