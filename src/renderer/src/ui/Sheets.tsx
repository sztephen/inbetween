import { motion } from 'motion/react'
import { useState } from 'react'
import { activeClip, activeRig, api, fpRig, useStore } from '../store'

const spring = { type: 'spring' as const, stiffness: 420, damping: 32 }

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="sheet" role="dialog" aria-label={title} initial={{ opacity: 0, y: 26, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 14, scale: 0.98 }} transition={spring}>
        <h1>{title}</h1>
        {children}
      </motion.div>
    </motion.div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return <button className="btn small" onClick={() => {
    void api.copy(text)
    setDone(true)
    setTimeout(() => setDone(false), 1400)
  }}>{done ? 'Copied' : label}</button>
}

export function SettingsSheet(): React.JSX.Element | null {
  const st = useStore((s) => s.settings)
  const close = (): void => useStore.getState().set({ sheet: null })
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState('')
  if (!st) return null
  const apply = (p: Promise<unknown>): void => void p.then((v) => v && useStore.getState().set({ settings: v as typeof st }))
  const saveKey = (): void => {
    setKeyError('')
    api.setApiKey(key).then((v) => {
      useStore.getState().set({ settings: v })
      setKey('')
    }).catch((e: Error) => setKeyError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')))
  }
  return (
    <Sheet title="Settings" onClose={close}>
      <section>
        <h3>Claude API key</h3>
        <p>Used by the chat panel. Stored encrypted in your {st.platform === 'darwin' ? 'macOS Keychain' : st.platform === 'win32' ? 'Windows credential store' : 'system keyring'} and sent only to Anthropic.</p>
        {st.hasKey
          ? <div className="row"><span className="status on">Saved, {st.keyHint}</span><span className="grow" /><button className="btn small" onClick={() => apply(api.setApiKey(null))}>Remove key</button></div>
          : <div className="row">
            <input className="field grow" type="password" placeholder="sk-ant-…" value={key} autoComplete="off" spellCheck={false} aria-label="Claude API key" onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && saveKey()} />
            <button className="btn primary" disabled={!key.trim()} onClick={saveKey}>Save key</button>
          </div>}
        {keyError && <p style={{ color: 'var(--danger)' }}>{keyError}</p>}
        {!st.encryptionAvailable && <p style={{ color: 'var(--danger)' }}>Secure storage is not available on this system, so a key cannot be saved.</p>}
        <div className="row">
          <span className="quiet grow">Models in the picker come from an editable file.</span>
          <button className="btn small" onClick={() => void api.openModelsFile()}>Edit models file</button>
        </div>
      </section>
      <section>
        <h3>Connect an MCP client</h3>
        <p>Claude Code, Claude Desktop and other MCP clients can animate in this app with the same tools as the chat panel. No API key needed. The app must be open.</p>
        <div className="row">
          <span className={`status${st.mcp.running ? ' on' : ''}`}>{st.mcp.running ? `Listening on 127.0.0.1:${st.mcp.port}` : st.mcp.error ?? 'Not running'}</span>
          {st.mcp.clients > 0 && <span className="quiet">{st.mcp.clients} connected</span>}
        </div>
        <div className="row">
          <CopyButton text={st.mcp.claudeCodeCommand} label="Copy Claude Code command" />
          <CopyButton text={st.mcp.httpConfig} label="Copy MCP config (HTTP)" />
          <CopyButton text={st.mcp.stdioConfig} label="Copy MCP config (stdio)" />
        </div>
        <p className="quiet">Claude Code: paste the command in a terminal. Claude Desktop: paste the stdio config into claude_desktop_config.json.</p>
      </section>
      <section>
        <h3>Roblox Studio plugin</h3>
        <p>Sends a selected rig from Studio to Inbetween and imports the current animation back as a KeyframeSequence.</p>
        <div className="row">
          <button className="btn small" onClick={() => void api.installStudioPlugin().then((r) => useStore.getState().toast(r.ok ? 'Plugin installed. Restart Roblox Studio to load it.' : `Could not install the plugin: ${r.error}`, r.ok ? 'info' : 'error', r.path))}>Install plugin</button>
        </div>
      </section>
      <section>
        <h3>Appearance</h3>
        <div className="row">
          <span className="seg">{(['system', 'light', 'dark'] as const).map((t) => <button key={t} aria-pressed={st.settings.theme === t} onClick={() => apply(api.setSettings({ theme: t }))}>{t[0].toUpperCase() + t.slice(1)}</button>)}</span>
        </div>
      </section>
      <div className="foot"><span className="quiet grow" style={{ alignSelf: 'center' }}>Inbetween {st.version}</span><button className="btn" onClick={close}>Done</button></div>
    </Sheet>
  )
}

const FORMATS = [
  { id: 'rbxmx', name: 'Roblox', note: 'KeyframeSequence .rbxmx' },
  { id: 'glb', name: 'glTF', note: 'Rig + baked animation .glb' },
  { id: 'mp4', name: 'MP4', note: 'H.264 video' },
  { id: 'gif', name: 'GIF', note: 'Looping image' },
  { id: 'webm', name: 'WebM', note: 'Video with transparency' }
] as const

export function ExportSheet(): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const progress = useStore((s) => s.exportProgress)
  const close = (): void => useStore.getState().set({ sheet: null })
  const clip = activeClip({ doc }), rig = activeRig({ doc })
  const [format, setFormat] = useState<(typeof FORMATS)[number]['id']>('rbxmx')
  const [size, setSize] = useState('1280x720')
  const [fps, setFps] = useState(0)
  const [bg, setBg] = useState<'theme' | 'transparent' | 'color'>('theme')
  const [color, setColor] = useState('#16181d')
  const [camera, setCamera] = useState('auto')
  const [busy, setBusy] = useState(false)
  if (!clip || !rig) return null
  const video = format === 'mp4' || format === 'gif' || format === 'webm'
  const canAlpha = format !== 'mp4'
  const robloxBlocked = format === 'rbxmx' && rig.source === 'gltf'
  const run = (): void => {
    const [w, h] = size.split('x').map(Number)
    setBusy(true)
    void api.exportClip({
      format, clip: clip.id, rig: video && (camera === 'first_person' || camera === 'head_cam') ? fpRig({ doc })?.id ?? rig.id : rig.id,
      ...(video ? { width: w, height: h, fps: fps || clip.fps, background: bg === 'color' ? color : bg === 'transparent' && canAlpha ? 'transparent' : 'theme', ...(camera !== 'auto' ? { camera } : {}) } : {})
    }).then((r) => {
      setBusy(false)
      if (r.ok && r.path) {
        useStore.getState().toast(`Exported ${r.path.replace(/^.*[\\/]/, '')}`, 'info', r.path)
        close()
      } else if (r.error) useStore.getState().toast(/cancelled/i.test(r.error) ? 'Render stopped.' : r.error, /cancelled/i.test(r.error) ? 'info' : 'error')
    })
  }
  return (
    <Sheet title={`Export "${clip.name}"`} onClose={() => !busy && close()}>
      <section>
        <div className="choice">{FORMATS.map((f) => <button key={f.id} aria-pressed={format === f.id} onClick={() => setFormat(f.id)}><b>{f.name}</b><span>{f.note}</span></button>)}</div>
        {format === 'rbxmx' && <p>{robloxBlocked ? `"${rig.name}" is a glTF rig. Roblox export needs a Roblox rig; choose glTF instead.` : `Exports ${rig.name}. Drag the file into Roblox Studio, or use the Studio plugin's Import button, then publish it from the Animation Editor.`}</p>}
        {format === 'glb' && <p>Exports {rig.name} with the animation baked at {clip.fps} fps, for Unity, Unreal, Godot or Blender. For FBX, convert the .glb in Blender (see the README).</p>}
      </section>
      {video && (
        <section>
          <div className="formgrid">
            <label htmlFor="ex-size">Resolution</label>
            <select id="ex-size" className="field" value={size} onChange={(e) => setSize(e.target.value)}>
              {['640x360', '960x540', '1280x720', '1920x1080', '720x720', '1080x1080', '1080x1920'].map((s) => <option key={s} value={s}>{s.replace('x', ' × ')}</option>)}
            </select>
            <label htmlFor="ex-fps">Frame rate</label>
            <select id="ex-fps" className="field" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              <option value={0}>Same as clip ({clip.fps} fps)</option>
              {[12, 15, 24, 30, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
            <label htmlFor="ex-cam">Camera</label>
            <select id="ex-cam" className="field" value={camera} onChange={(e) => setCamera(e.target.value)}>
              <option value="auto">{clip.camera.length ? 'Camera track' : 'Three-quarter'}</option>
              {clip.camera.length > 0 && <option value="three_quarter">Three-quarter</option>}
              <option value="front">Front</option><option value="side">Right side</option><option value="left">Left side</option><option value="back">Back</option><option value="top">Top</option>
              {fpRig({ doc }) && <option value="first_person">First person</option>}
              {fpRig({ doc }) && <option value="head_cam">First person, locked to head</option>}
            </select>
            <label>Background</label>
            <div className="row">
              <span className="seg">
                <button aria-pressed={bg === 'theme'} onClick={() => setBg('theme')}>Studio</button>
                <button aria-pressed={bg === 'color'} onClick={() => setBg('color')}>Colour</button>
                <button aria-pressed={bg === 'transparent'} disabled={!canAlpha} title={canAlpha ? '' : 'MP4 cannot store transparency. Use WebM or GIF.'} style={canAlpha ? undefined : { opacity: 0.4 }} onClick={() => canAlpha && setBg('transparent')}>Transparent</button>
              </span>
              {bg === 'color' && <input type="color" value={color} aria-label="Background colour" onChange={(e) => setColor(e.target.value)} />}
            </div>
          </div>
          {bg === 'transparent' && !canAlpha && <p>MP4 cannot store transparency, so this will use the studio background. Choose WebM or GIF for a transparent result.</p>}
        </section>
      )}
      {busy && progress?.active && (
        <section>
          <span className="quiet">{progress.label}, {Math.round(progress.progress * 100)}%</span>
          <div className="progress"><motion.i animate={{ scaleX: Math.max(0.02, progress.progress) }} transition={{ type: 'spring', stiffness: 200, damping: 30 }} /></div>
        </section>
      )}
      <div className="foot">
        {busy && video
          ? <button className="btn" onClick={() => void api.cancelExport()}>Stop render</button>
          : <button className="btn" disabled={busy} onClick={close}>Cancel</button>}
        <button className="btn primary" disabled={busy || robloxBlocked} onClick={run}>{busy ? 'Exporting…' : 'Export'}</button>
      </div>
    </Sheet>
  )
}
