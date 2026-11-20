import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { activeClip, activeRig, command, isMac, useStore } from '../store'
import { IconChat, IconChevron, IconExport, IconEye, IconGear, IconRedo, IconUndo } from './icons'

const spring = { type: 'spring' as const, stiffness: 520, damping: 32 }

function Popover({ label, sub, children }: { label: string; sub?: string; children: (close: () => void) => React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', off)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', off)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="crumb" aria-expanded={open} onClick={() => setOpen(!open)}>{label}{sub && <span className="sub">{sub}</span>}<IconChevron /></button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu" style={{ top: 32, left: 0, transformOrigin: 'top left' }} initial={{ opacity: 0, scale: 0.94, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} transition={spring}>
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function TopBar(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const chatOpen = useStore((s) => s.chatOpen)
  const firstPerson = useStore((s) => s.firstPerson)
  const clip = activeClip({ doc }), rig = activeRig({ doc })
  return (
    <header className={`topbar${isMac ? ' mac' : ''}`}>
      {doc && clip && (
        <Popover label={clip.name} sub={`${clip.length}f`}>
          {(close) => <>
            <span className="quiet">Clips</span>
            {doc.project.clips.map((c) => (
              <button key={c.id} role="menuitemradio" aria-checked={c.id === clip.id} onClick={() => {
                void command({ type: 'setActive', clipId: c.id })
                useStore.getState().set({ frame: 0, playing: false, selectedKeys: [] })
                close()
              }}>{c.name}<span className="quiet">{c.length}f{c.loop ? ', loop' : ''}</span></button>
            ))}
            <hr />
            <button onClick={() => {
              void command({ type: 'newClip', name: `Clip ${doc.project.clips.length + 1}` })
              useStore.getState().set({ frame: 0, playing: false, selectedKeys: [] })
              close()
            }}>New clip</button>
          </>}
        </Popover>
      )}
      {doc && rig && doc.project.rigs.length > 0 && <>
        <span className="crumb-sep">/</span>
        <Popover label={rig.name}>
          {(close) => <>
            <span className="quiet">Rigs in this scene</span>
            {doc.project.rigs.map((r) => (
              <button key={r.id} role="menuitemradio" aria-checked={r.id === rig.id} onClick={() => {
                void command({ type: 'setActive', rigId: r.id })
                useStore.getState().set({ selectedBone: null, selectedChain: null, selectedKeys: [] })
                close()
              }}>{r.name}<span className="quiet">{r.source === 'r15' ? 'R15' : r.source}</span></button>
            ))}
            <hr />
            <button onClick={() => {
              close()
              void window.inbetween.file('importRig').then((r) => r.error && useStore.getState().toast(r.error, 'error'))
            }}>Import rig…</button>
          </>}
        </Popover>
      </>}
      <div className="spacer" />
      <button className="icon-btn" aria-label="First person" title="First-person view through the rig's eyes (V). Click again for the head-locked camera, again to leave." aria-pressed={!!firstPerson} disabled={!rig?.head}
        onClick={() => useStore.getState().set({ firstPerson: firstPerson === false ? 'first_person' : firstPerson === 'first_person' ? 'head_cam' : false })}><IconEye /></button>
      <button className="icon-btn" aria-label="Undo" title="Undo" disabled={!doc?.canUndo} onClick={() => void command({ type: 'undo' })}><IconUndo /></button>
      <button className="icon-btn" aria-label="Redo" title="Redo" disabled={!doc?.canRedo} onClick={() => void command({ type: 'redo' })}><IconRedo /></button>
      <button className="icon-btn" aria-label="Export" title="Export" onClick={() => useStore.getState().set({ sheet: 'export' })}><IconExport /></button>
      <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => useStore.getState().set({ sheet: 'settings' })}><IconGear /></button>
      <button className="icon-btn" aria-label="Chat" title="Show or hide chat" aria-pressed={chatOpen} onClick={() => {
        useStore.getState().set({ chatOpen: !chatOpen })
        void window.inbetween.setSettings({ chatOpen: !chatOpen })
      }}><IconChat /></button>
    </header>
  )
}

export function SelectionPill(): React.JSX.Element {
  const bone = useStore((s) => s.selectedBone)
  const chain = useStore((s) => s.selectedChain)
  const gizmo = useStore((s) => s.gizmo)
  const doc = useStore((s) => s.doc)
  const rig = activeRig({ doc })
  const def = rig?.bones.find((b) => b.name === bone)
  const firstPerson = useStore((s) => s.firstPerson)
  const label = firstPerson ? (firstPerson === 'head_cam' ? 'First person, camera locked to the head' : 'First person') : chain ? `${chain.replace('_', ' ')} target` : bone
  return (
    <AnimatePresence>
      {label && (
        <motion.div key="pill" className="selection-pill panel" initial={{ opacity: 0, y: -10, x: '-50%', scale: 0.94 }} animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }} exit={{ opacity: 0, y: -8, x: '-50%', scale: 0.96 }} transition={spring}>
          <span style={{ fontWeight: 560 }}>{label}</span>
          {firstPerson ? <span className="quiet" style={{ paddingRight: 10 }}>V to change</span> : def?.locked ? <span className="quiet" style={{ paddingRight: 10 }}>locked</span>
            : chain ? <span className="quiet" style={{ paddingRight: 10 }}>drag to pose</span>
              : def?.translatable
                ? <span className="seg">{(['rotate', 'move'] as const).map((m) => <button key={m} aria-pressed={gizmo === m} onClick={() => useStore.getState().set({ gizmo: m })}>{m === 'rotate' ? 'Rotate' : 'Move'}</button>)}</span>
                : <span className="quiet" style={{ paddingRight: 10 }}>drag a ring to rotate</span>}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
