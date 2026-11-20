import { motion } from 'motion/react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, command, reducedMotion, useStore, type ChatMessage, type ChatPart, type ChatTool } from '../store'
import { IconAlert, IconCheck, IconSend, IconStop } from './icons'

const spring = { type: 'spring' as const, stiffness: 480, damping: 30 }

/** Reveal streamed text at a steady pace so it flows instead of arriving in bursts. */
function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(streaming && !reducedMotion() ? 0 : text.length)
  const target = useRef(text.length)
  target.current = text.length
  useEffect(() => {
    if (!streaming || reducedMotion()) {
      setShown(text.length)
      return
    }
    let raf = 0
    const step = (): void => {
      setShown((n) => {
        const behind = target.current - n
        return behind <= 0 ? n : n + Math.max(1, Math.ceil(behind / 9))
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [streaming, text.length === 0])
  return text.slice(0, Math.min(shown, text.length))
}

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0, m: RegExpExecArray | null, i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    out.push(t.startsWith('**') ? <strong key={`${keyBase}${i++}`}>{t.slice(2, -2)}</strong> : <code key={`${keyBase}${i++}`}>{t.slice(1, -1)}</code>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Just enough Markdown for chat replies: paragraphs, bullet lists, bold and inline code. */
function Rich({ text, caret }: { text: string; caret: boolean }): React.JSX.Element {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim())
  return <>
    {blocks.map((b, bi) => {
      const lines = b.split('\n')
      const last = bi === blocks.length - 1
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return <ul key={bi}>{lines.map((l, li) => <li key={li}>{inline(l.replace(/^\s*[-*]\s+/, ''), `${bi}-${li}-`)}{caret && last && li === lines.length - 1 && <span className="caret" />}</li>)}</ul>
      }
      return <p key={bi}>{lines.map((l, li) => <span key={li}>{inline(l.replace(/^#+\s*/, ''), `${bi}-${li}-`)}{li < lines.length - 1 && <br />}</span>)}{caret && last && <span className="caret" />}</p>
    })}
  </>
}

function Chip({ tool, onImage }: { tool: ChatTool; onImage: (src: string) => void }): React.JSX.Element {
  return (
    <motion.span layout="position" className={`chip ${tool.status}`} initial={reducedMotion() ? false : { opacity: 0, scale: 0.7, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={spring}
      title={tool.status === 'error' ? tool.summary : tool.name} onClick={() => tool.image && onImage(tool.image)}>
      {tool.status === 'running' ? <span className="dot" /> : tool.status === 'error' ? <IconAlert /> : <IconCheck />}
      {tool.chip}
    </motion.span>
  )
}

function TextPart({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const shown = useSmoothText(text, streaming)
  return <Rich text={shown} caret={streaming} />
}

const fmt = (n: number): string => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const Message = memo(function Message({ m, onImage, isLast, worker }: { m: ChatMessage; onImage: (src: string) => void; isLast: boolean; worker?: string }) {
  if (m.role === 'user') return <motion.div className="msg user" initial={reducedMotion() ? false : { opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}>{m.from && <span className="msg-from">From {m.from}</span>}{m.text}</motion.div>
  if (m.role === 'error') {
    return (
      <motion.div className="msg error" role="alert" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
        <span>{m.text}</span>
        <div className="row">
          {m.retryable && isLast && <button className="btn small" onClick={() => void api.agentRetry(worker)}>Retry</button>}
          {(m.errorKind === 'no_key' || m.errorKind === 'auth') && <button className="btn small" onClick={() => useStore.getState().set({ sheet: 'settings' })}>Open Settings</button>}
        </div>
      </motion.div>
    )
  }
  // Group consecutive tool calls into one row of chips.
  const groups: (ChatPart | { kind: 'tools'; tools: ChatTool[] })[] = []
  for (const p of m.parts) {
    const prev = groups[groups.length - 1]
    if (p.kind === 'tool' && prev && prev.kind === 'tools') prev.tools.push(p.tool)
    else if (p.kind === 'tool') groups.push({ kind: 'tools', tools: [p.tool] })
    else groups.push(p)
  }
  const lastText = [...m.parts].reverse().find((p) => p.kind === 'text')
  const waiting = m.streaming && !m.parts.length
  const usage = m.usage
  return (
    <div className="msg assistant">
      {waiting && <div className="thinking"><span className="bars"><i /><i /><i /></span>{m.thinking ? m.thinking.trim().split('\n').pop()!.slice(-64) : 'thinking'}</div>}
      {groups.map((g, i) => g.kind === 'tools'
        ? <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="chips">{g.tools.map((t) => <Chip key={t.toolId} tool={t} onImage={onImage} />)}</div>
          {g.tools.filter((t) => t.image).map((t) => (
            <motion.img key={t.toolId} className="thumb" alt="Preview contact sheet" src={`data:image/png;base64,${t.image}`} onClick={() => onImage(t.image!)}
              initial={reducedMotion() ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={spring} />
          ))}
        </div>
        : g.kind === 'text' ? <TextPart key={i} text={g.text} streaming={!!m.streaming && g === lastText} /> : null)}
      {usage && !m.streaming && (
        <span className="usage" title={`Input ${usage.input} (+${usage.cacheRead} cached, ${usage.cacheWrite} written to cache), output ${usage.output}`}>
          {fmt(usage.input + usage.cacheRead + usage.cacheWrite)} tokens in, {fmt(usage.output)} out
        </span>
      )}
    </div>
  )
})

const SUGGESTIONS = [
  'Animate a heavy right-hand punch with a held impact, about one second',
  'Make a looping walk cycle, 24 frames',
  'Wave hello, friendly and a little bouncy'
]

export function Chat(): React.JSX.Element {
  const mainMessages = useStore((s) => s.messages)
  const mainBusy = useStore((s) => s.agentBusy)
  const threads = useStore((s) => s.threads)
  const tab = useStore((s) => s.chatTab)
  // A tab per parallel animator; "All" is the lead conversation.
  const thread = threads.find((t) => t.id === tab)
  const worker = thread?.id
  const messages = thread ? thread.messages : mainMessages
  const busy = thread ? thread.busy : mainBusy
  const settings = useStore((s) => s.settings)
  const [text, setText] = useState('')
  const setLightbox = (src: string): void => useStore.getState().set({ lightbox: src })
  const scroller = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(140, el.scrollHeight)}px`
  }, [text])

  const send = (value = text): void => {
    const v = value.trim()
    if (!v || busy) return
    const s = useStore.getState()
    const mine: ChatMessage = { id: `u${Date.now()}`, role: 'user', text: v, parts: [] }
    if (worker) s.set({ threads: s.threads.map((t) => (t.id === worker ? { ...t, messages: [...t.messages, mine] } : t)) })
    else s.set({ messages: [...s.messages, mine] })
    stick.current = true
    setText('')
    void api.agentSend(v, { frame: s.frame, selectedBone: s.selectedBone }, worker)
  }

  const openTab = (id: string): void => {
    const s = useStore.getState()
    stick.current = true
    s.set({ chatTab: id })
    // Opening an animator's tab puts its clip on screen.
    const t = s.threads.find((x) => x.id === id)
    if (t && s.doc?.project.clips.some((c) => c.id === t.clipId) && s.doc.project.activeClipId !== t.clipId) {
      void command({ type: 'setActive', clipId: t.clipId })
      s.set({ frame: 0, playing: false, selectedKeys: [] })
    }
  }

  const visible = messages.filter((m) => m.role !== 'assistant' || m.streaming || m.parts.length)
  return (
    <motion.aside className="chat panel" aria-label="Chat"
      initial={{ x: 380, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 380, opacity: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 34 }}>
      {threads.length > 0 && (
        <div className="chat-tabs" role="tablist" aria-label="Animations in progress">
          <button role="tab" aria-selected={!thread} onClick={() => openTab('main')}>All{mainBusy && <span className="dot" />}</button>
          {threads.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === tab} title={t.busy ? `${t.name}: animating` : `${t.name}: finished`} onClick={() => openTab(t.id)}>
              {t.name}{t.busy ? <span className="dot" /> : <IconCheck />}
            </button>
          ))}
        </div>
      )}
      <div className="chat-scroll" ref={scroller} onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}>
        {!visible.length && (
          <div className="chat-empty">
            <h2>Describe a motion. Watch it get animated.</h2>
            <p>Claude poses the rig, looks at its own previews, and checks the result. Give notes at any point, or adjust a pose yourself.</p>
            {settings && !settings.hasKey && (
              <p>To chat here, <button style={{ color: 'var(--accent)', fontWeight: 600 }} onClick={() => useStore.getState().set({ sheet: 'settings' })}>add your Claude API key</button>. Or connect Claude Code over MCP from Settings, no key needed.</p>
            )}
            <div className="suggest">{SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        {visible.map((m, i) => <Message key={m.id} m={m} onImage={setLightbox} isLast={i === visible.length - 1} worker={worker} />)}
      </div>
      <div className="composer">
        <textarea ref={area} rows={1} value={text} placeholder={thread ? `Give a note on ${thread.name}…` : visible.length ? 'Give a note…' : 'What should the rig do?'} aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }} />
        <div className="row">
          <select aria-label="Model" value={settings?.settings.model ?? ''} onChange={(e) => void api.setSettings({ model: e.target.value }).then((settings) => useStore.getState().set({ settings }))}>
            {(settings?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {(() => {
            const model = settings?.models.find((m) => m.id === settings.settings.model) ?? settings?.models[0]
            const effort = settings?.settings.effort ?? model?.effort ?? 'medium'
            const levels = ['low', 'medium', 'high']
            return (
              <select aria-label="Thinking effort" title="How hard the AI thinks. Higher makes better animation but is slower and costs more." value={effort}
                onChange={(e) => void api.setSettings({ effort: e.target.value as 'low' | 'medium' | 'high' }).then((settings) => useStore.getState().set({ settings }))}>
                {(levels.includes(effort) ? levels : [...levels, effort]).map((l) => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)} effort</option>)}
              </select>
            )
          })()}
          {visible.length > 0 && !busy && !thread && !threads.some((t) => t.busy) && <button className="quiet" title="Start a new conversation" onClick={() => void api.agentReset()}>New chat</button>}
          {busy
            ? <motion.button className="send stop" whileTap={{ scale: 0.88 }} aria-label="Stop" title="Stop" onClick={() => void api.agentStop(worker)}><IconStop /></motion.button>
            : <motion.button className="send" whileTap={{ scale: 0.88 }} aria-label="Send" title="Send (Enter)" disabled={!text.trim()} onClick={() => send()}><IconSend /></motion.button>}
        </div>
      </div>
    </motion.aside>
  )
}
