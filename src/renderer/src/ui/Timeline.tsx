import { AnimatePresence, motion, useMotionValue, useSpring } from 'motion/react'
import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { TIMING_PRESETS } from '@core/easing'
import { easingAt, presetName, summarizeKeys } from '@core/ops'
import type { Clip, Rig } from '@core/types'
import { activeClip, activeRig, command, reducedMotion, useStore } from '../store'
import { IconLoop, IconPause, IconPlay } from './icons'

const PAD = 14
const SPEEDS = [0.25, 0.5, 1, 2]
const spring = { type: 'spring' as const, stiffness: 520, damping: 26 }

function useWidth(el: HTMLDivElement | null): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [el])
  return w
}

/** The playhead reads the frame straight from the store so playback does not re-render the timeline. */
function Playhead({ toX }: { toX: (f: number) => number }): React.JSX.Element {
  const target = useMotionValue(toX(useStore.getState().frame))
  const x = useSpring(target, { stiffness: 900, damping: 55, mass: 0.6 })
  useEffect(() => {
    const apply = (): void => {
      const s = useStore.getState()
      const v = toX(s.frame)
      // Glide when scrubbing or stepping; track exactly while playing.
      if (s.playing || reducedMotion()) x.jump(v)
      else target.set(v)
    }
    apply()
    return useStore.subscribe((s, p) => {
      if (s.frame !== p.frame || s.playing !== p.playing) apply()
    })
  }, [toX, target, x])
  return <motion.div className="playhead" style={{ x }} />
}

function Readout({ length }: { length: number }): React.JSX.Element {
  const frame = useStore((s) => Math.round(s.frame))
  return <div className="readout"><b>{frame}</b> / {length}</div>
}

const Keys = memo(function Keys({ clip, rig, toX, version, touched }: { clip: Clip; rig: Rig; toX: (f: number) => number; version: number; touched: number[] }) {
  const selected = useStore((s) => s.selectedKeys)
  const summary = useMemo(() => summarizeKeys(clip, rig), [clip, rig])
  const full = new Set(summary.allBonesFrames)
  const [drag, setDrag] = useState<{ from: number; delta: number } | null>(null)
  const perFrame = toX(1) - toX(0)

  const onDown = (e: React.PointerEvent, frame: number): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    const s = useStore.getState()
    const already = s.selectedKeys.includes(frame)
    if (e.shiftKey) s.set({ selectedKeys: already ? s.selectedKeys.filter((f) => f !== frame) : [...s.selectedKeys, frame] })
    else if (!already) s.set({ selectedKeys: [frame] })
    const startX = e.clientX
    const copy = e.altKey
    let delta = 0
    const move = (ev: PointerEvent): void => {
      delta = Math.round((ev.clientX - startX) / perFrame)
      setDrag(delta ? { from: frame, delta } : null)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      const st = useStore.getState()
      if (!delta) {
        st.set({ frame, playing: false })
        return
      }
      const keys = st.selectedKeys.length ? st.selectedKeys : [frame]
      const moves = keys.map((f) => ({ from: f, to: Math.max(0, f + delta) }))
      void command({ type: 'moveKeys', moves, copy })
      st.set({ selectedKeys: moves.map((m) => m.to) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <AnimatePresence initial={false}>
      {summary.frames.map((f) => {
        const isSel = selected.includes(f)
        const shift = drag && (isSel || drag.from === f) ? drag.delta : 0
        // A key the AI or the user just wrote re-mounts so it pops again.
        const pulse = touched.includes(f) ? version : 0
        return (
          <motion.div
            key={f}
            className={`pip${full.has(f) ? '' : ' partial'}${isSel ? ' selected' : ''}`}
            style={{ left: toX(Math.max(0, f + shift)) }}
            initial={reducedMotion() ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={spring}
            whileHover={{ scale: 1.25 }}
            onPointerDown={(e) => onDown(e, f)}
            title={`Key at frame ${f}${full.has(f) ? '' : ' (some bones)'}. Drag to move, Alt-drag to copy.`}
            data-frame={f}
          >
            {/* Re-mounting the inner span replays the pop when the AI or the user rewrites this key. */}
            <motion.span key={pulse} style={{ display: 'grid' }} initial={pulse && !reducedMotion() ? { scale: 2.1 } : false} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 14 }}><i /></motion.span>
          </motion.div>
        )
      })}
    </AnimatePresence>
  )
})

function KeyMenu({ clip, rig, toX }: { clip: Clip; rig: Rig; toX: (f: number) => number }): React.JSX.Element | null {
  const selected = useStore((s) => s.selectedKeys)
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [selected.join(',')])
  if (!selected.length) return null
  const first = Math.min(...selected)
  const current = easingAt(clip, rig, first)
  const name = current ? presetName(current) : 'linear'
  const left = Math.min(Math.max(toX(first) - 40, 0), Math.max(0, toX(clip.length) - 300))
  return (
    <motion.div className="key-menu panel" style={{ left }} initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.97 }} transition={spring}
      onPointerDown={(e) => e.stopPropagation()}>
      {open
        ? Object.keys(TIMING_PRESETS).map((p) => (
          <button key={p} aria-pressed={p === name} title={TIMING_PRESETS[p].note} onClick={() => {
            void command({ type: 'setEasing', frames: selected, preset: p })
            setOpen(false)
          }}>{p}</button>
        ))
        : <>
          <span className="quiet" style={{ padding: '0 6px 0 8px' }}>{selected.length > 1 ? `${selected.length} keys` : `frame ${first}`}</span>
          <button onClick={() => setOpen(true)} title="Easing toward the next key">ease: {name}</button>
          <span className="sep" />
          <button title="Copy these keys to the playhead" onClick={() => {
            const s = useStore.getState()
            const d = Math.round(s.frame) - first
            if (!d) return s.toast('Move the playhead to where the copy should go, then copy.')
            void command({ type: 'moveKeys', moves: selected.map((f) => ({ from: f, to: f + d })), copy: true })
          }}>copy to playhead</button>
          <button title="Delete these keys" onClick={() => {
            void command({ type: 'deleteKeys', frames: selected })
            useStore.getState().set({ selectedKeys: [] })
          }}>delete</button>
        </>}
    </motion.div>
  )
}

export function Timeline(): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const [trackEl, setTrackEl] = useState<HTMLDivElement | null>(null)
  const width = useWidth(trackEl)
  const clip = activeClip({ doc }), rig = activeRig({ doc })
  const length = clip?.length ?? 1
  const toX = useMemo(() => {
    const usable = Math.max(1, width - PAD * 2)
    return (f: number): number => PAD + (f / Math.max(1, length)) * usable
  }, [width, length])

  if (!clip || !rig || !doc) return null

  const perFrame = toX(1) - toX(0)
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => s * perFrame >= 34) ?? 1000
  const ticks: number[] = []
  for (let f = 0; f <= length; f += step) ticks.push(f)
  const minor = step >= 5 && (step / 5) * perFrame >= 6 ? step / 5 : step >= 2 && perFrame >= 6 ? 1 : 0

  const scrub = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const el = trackEl!
    const set = (clientX: number): void => {
      const r = el.getBoundingClientRect()
      const f = Math.round(((clientX - r.left - PAD) / Math.max(1, r.width - PAD * 2)) * length)
      useStore.getState().set({ frame: Math.min(length, Math.max(0, f)), playing: false })
    }
    set(e.clientX)
    useStore.getState().set({ selectedKeys: [] })
    const move = (ev: PointerEvent): void => set(ev.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const touched = doc.touched?.clipId === clip.id || !doc.touched?.clipId ? doc.touched?.frames ?? [] : []

  return (
    <motion.div className="timeline panel" initial={{ y: 90, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 320, damping: 30, delay: 0.05 }}>
      <div className="transport">
        <motion.button className="play" whileTap={{ scale: 0.88 }} transition={spring} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)"
          onClick={() => {
            const s = useStore.getState()
            s.set({ playing: !s.playing, frame: !s.playing && s.frame >= length ? 0 : s.frame })
          }}>{playing ? <IconPause /> : <IconPlay />}</motion.button>
        <button className="icon-btn" aria-pressed={clip.loop} aria-label="Loop" title="Loop this clip (L)" onClick={() => void command({ type: 'updateClip', patch: { loop: !clip.loop } })}><IconLoop /></button>
        <button className="speed" title="Playback speed" onClick={() => useStore.getState().set({ speed: SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] })}>{speed}×</button>
      </div>
      <div className="track" ref={setTrackEl} onPointerDown={scrub}>
        {width > 0 && <>
          {minor > 0 && Array.from({ length: Math.floor(length / minor) + 1 }, (_, i) => i * minor).filter((f) => f % step).map((f) => <div key={`m${f}`} className="tick" style={{ left: toX(f) }} />)}
          {ticks.map((f) => <div key={f}><div className="tick major" style={{ left: toX(f) }} /><div className="tick-label" style={{ left: toX(f) }}>{f}</div></div>)}
          <div className="lane" />
          {clip.contacts.filter((c) => c.rig === rig.id).map((c) => (
            <motion.div key={c.id} className={`contact-bar${/left/i.test(c.chain) ? ' left' : ''}`} style={{ left: toX(c.start), width: Math.max(3, toX(c.end) - toX(c.start)) }}
              initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={spring} title={`${c.chain.replace('_', ' ')} planted, frames ${c.start} to ${c.end}`} />
          ))}
          {clip.camera.map((k) => <div key={`c${k.frame}`} className="cam-key" style={{ left: toX(k.frame) }} title={`Camera key at frame ${k.frame}`} />)}
          {clip.markers.map((m) => <div key={`${m.name}${m.frame}`} className="marker" style={{ left: toX(m.frame) }}>{m.name}</div>)}
          <Keys clip={clip} rig={rig} toX={toX} version={doc.version} touched={touched} />
          <Playhead toX={toX} />
          <KeyMenu clip={clip} rig={rig} toX={toX} />
        </>}
      </div>
      <Readout length={length} />
    </motion.div>
  )
}
