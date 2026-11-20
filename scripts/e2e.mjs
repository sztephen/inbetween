// End-to-end check of the built app: launches Electron, drives it through a real MCP client,
// the built-in agent against a mocked Claude API, and the manual controls, saving screenshots
// to test-results/. Run with: npm run test:e2e
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const out = join(root, 'test-results')
mkdirSync(out, { recursive: true })
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const want = (name) => !only.length || only.includes(name)
const results = []
const ok = (name, detail = '') => {
  results.push({ name, ok: true })
  console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`)
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- mock Claude API: scripted streaming responses -------------------------------------------
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' })
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}
function streamOf(blocks, stop, usage = { input_tokens: 1200, output_tokens: 80 }) {
  const ev = [{ type: 'message_start', message: { id: `msg_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant', model: 'claude-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
      for (const piece of b.text.match(/.{1,14}/gs) ?? []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } })
    } else {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      const json = JSON.stringify(b.input)
      for (const piece of json.match(/.{1,20}/gs) ?? []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: piece } })
    }
    ev.push({ type: 'content_block_stop', index: i })
  })
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
  ev.push({ type: 'message_stop' })
  return ev
}
function startMock() {
  const state = { requests: [], mode: 'ok' }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {}
      state.requests.push({ url: req.url, headers: req.headers, body: json })
      if (state.mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
      }
      if (state.mode === 'rate') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7', 'x-should-retry': 'false' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }))
      }
      const turnsWithResults = json.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')).length
      if (turnsWithResults === 0) {
        return sse(res, streamOf([
          { type: 'text', text: 'Blocking a quick nod: head down at frame 10, back up by 20.' },
          { type: 'tool_use', id: 'toolu_1', name: 'create_clip', input: { name: 'Nod', length: 20 } },
          { type: 'tool_use', id: 'toolu_2', name: 'set_pose', input: { frame: 0, timing: 'floaty' } },
          { type: 'tool_use', id: 'toolu_3', name: 'set_pose', input: { frame: 10, bones: { Head: { rotation: [-28, 0, 0] } }, timing: 'floaty' } },
          { type: 'tool_use', id: 'toolu_4', name: 'copy_pose_to_frame', input: { from_frame: 0, to_frame: 20 } }
        ], 'tool_use'))
      }
      if (turnsWithResults === 1) {
        return sse(res, streamOf([
          { type: 'tool_use', id: 'toolu_5', name: 'preview', input: { frames: 'keys', views: ['front', 'side'] } },
          { type: 'tool_use', id: 'toolu_6', name: 'check', input: {} }
        ], 'tool_use'))
      }
      return sse(res, streamOf([{ type: 'text', text: 'Done. A **20-frame nod**: head dips at frame 10 and returns. The check is clean and I reviewed the preview.' }], 'end_turn', { input_tokens: 2400, output_tokens: 60 }))
    })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, state, url: `http://127.0.0.1:${server.address().port}` })))
}

// ---- app launch -----------------------------------------------------------------------------
async function launch(extraArgs = [], env = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'inbetween-e2e-'))
  const app = await electron.launch({ args: [root, `--user-data=${userData}`, '--e2e', ...extraArgs], env: { ...process.env, ...env }, cwd: root })
  const errors = []
  const page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForSelector('.timeline', { timeout: 30000 })
  await page.waitForSelector('.viewport canvas')
  await sleep(900)
  return { app, page, userData, errors }
}
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) })
const docOf = (page) => page.evaluate(() => window.inbetween.getDoc())

async function mcpConnect(userData) {
  const rt = JSON.parse(readFileSync(join(userData, 'mcp-runtime.json'), 'utf8'))
  const client = new Client({ name: 'inbetween-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(rt.url), { requestInit: { headers: { Authorization: `Bearer ${rt.token}` } } }))
  return { client, rt }
}
const text = (res) => res.content.find((c) => c.type === 'text')?.text ?? ''
const json = (res) => JSON.parse(text(res).split('\n\nNOTE:')[0])

async function run() {
  // ============================================================== 1. shell + MCP
  if (want('shell') || want('mcp') || want('manual') || want('export')) {
    const { app, page, userData, errors } = await launch()
    try {
      if (want('shell')) {
        console.log('shell')
        const title = await page.title()
        assert(/Inbetween/.test(title), `unexpected title ${title}`)
        const doc = await docOf(page)
        assert(doc.project.rigs[0].bones.length === 16, 'R15 rig not loaded')
        await shot(page, '01-launch')
        ok('app launches with the R15 rig, timeline and chat')
        // Viewport actually draws the rig: the canvas centre is not background-coloured everywhere.
        // A flat, empty canvas compresses to almost nothing; a lit rig on a grid does not.
        const drawn = (await page.locator('.viewport canvas').screenshot()).length
        assert(drawn > 40000, `viewport looks blank (${drawn} byte screenshot)`)
        ok('viewport renders the scene')
      }

      if (want('mcp')) {
        console.log('mcp')
        const rt = JSON.parse(readFileSync(join(userData, 'mcp-runtime.json'), 'utf8'))
        const unauth = await fetch(rt.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
        assert(unauth.status === 401, `expected 401 without a token, got ${unauth.status}`)
        const evil = await fetch(rt.url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', authorization: `Bearer ${rt.token}` }, body: '{}' })
        assert(evil.status === 403, `expected 403 for a foreign Origin, got ${evil.status}`)
        ok('MCP endpoint rejects missing tokens and foreign origins')

        const { client } = await mcpConnect(userData)
        assert(/Block the key poses/.test(client.getInstructions() ?? ''), 'server instructions should carry the animation workflow')
        const tools = (await client.listTools()).tools
        const names = tools.map((t) => t.name)
        for (const n of ['get_rig', 'set_pose', 'preview', 'check', 'export', 'undo', 'add_contact', 'set_timing']) assert(names.includes(n), `missing tool ${n}`)
        ok(`MCP client connected and listed ${tools.length} tools`)

        const rig = json(await client.callTool({ name: 'get_rig', arguments: {} }))
        assert(rig.ik_chains.some((c) => c.name === 'right_hand'), 'no right_hand chain')
        await client.callTool({ name: 'create_clip', arguments: { name: 'Wave', length: 36, loop: false, priority: 'Action' } })
        // A short wave: raise the right arm, swing the forearm side to side, lower it.
        const up = { right_hand: { position: [2.3, 4.7, -0.3], pole: [3, 2.5, 0.5] } }
        const steps = [
          { frame: 0, timing: 'floaty' },
          { frame: 8, goals: { right_hand: { position: [2.3, 4.7, -0.3], pole: [3, 2.5, 0.5] } }, hips: { position: [-0.08, 0, 0] }, look_at: [0, 4.6, -6], timing: 'snappy' },
          { frame: 14, goals: { right_hand: { position: [1.5, 5.1, -0.3], pole: [3, 2.5, 0.5] } }, timing: 'floaty' },
          { frame: 20, goals: up, timing: 'floaty' },
          { frame: 26, goals: { right_hand: { position: [1.5, 5.1, -0.3], pole: [3, 2.5, 0.5] } }, timing: 'heavy' },
          { frame: 36, from: 'rest', timing: 'linear' }
        ]
        for (const s of steps) {
          const res = await client.callTool({ name: 'set_pose', arguments: s })
          assert(!res.isError, `set_pose failed: ${text(res)}`)
          await sleep(120)
        }
        await client.callTool({ name: 'add_contact', arguments: { chain: 'left_foot', start: 0, end: 36 } })
        await client.callTool({ name: 'add_contact', arguments: { chain: 'right_foot', start: 0, end: 36 } })
        await client.callTool({ name: 'add_marker', arguments: { name: 'wave', frame: 14 } })
        const check = json(await client.callTool({ name: 'check', arguments: {} }))
        console.log('       check:', check.ok ? 'clean' : JSON.stringify(check.problems.map((p) => p.message)))
        const prev = await client.callTool({ name: 'preview', arguments: { frames: 'keys', views: ['front', 'side'], onion_skin: true, trails: ['right_hand'] } })
        assert(!prev.isError, `preview failed: ${text(prev)}`)
        const img = prev.content.find((c) => c.type === 'image')
        assert(img && img.mimeType === 'image/png', 'preview returned no image')
        const png = Buffer.from(img.data, 'base64')
        assert(png.subarray(1, 4).toString() === 'PNG' && png.length > 20000, `preview image looks wrong (${png.length} bytes)`)
        writeFileSync(join(out, 'mcp-wave-preview.png'), png)
        const w = png.readUInt32BE(16), h = png.readUInt32BE(20)
        ok('wave animation created over MCP and preview image returned', `${w}x${h}, ${Math.round(png.length / 1024)} KB`)
        const doc = await docOf(page)
        const clip = doc.project.clips.find((c) => c.name === 'Wave')
        assert(clip && Object.keys(clip.tracks.r15).length === 15, 'wave keys did not reach the app document')
        await sleep(400)
        await shot(page, '02-after-mcp-wave')
        ok('viewport document updated live from MCP edits')

        const def = await client.callTool({ name: 'preview', arguments: {} })
        writeFileSync(join(out, 'mcp-wave-preview-default.png'), Buffer.from(def.content.find((c) => c.type === 'image').data, 'base64'))
        // First person: place both hands in the picture, preview through the character's eyes.
        await client.callTool({ name: 'create_clip', arguments: { name: 'FP Swing', length: 20 } })
        await client.callTool({ name: 'set_pose', arguments: { frame: 0, goals: { right_hand: { view: [0.5, -0.45, 1.5], pole: [2.6, 1.5, 0.6] }, left_hand: { view: [-0.5, -0.55, 1.4], pole: [-2.6, 1.5, 0.6] } }, timing: 'heavy' } })
        await client.callTool({ name: 'set_pose', arguments: { frame: 6, goals: { right_hand: { view: [0.8, 0.1, 1.2], pole: [2.6, 1.5, 0.6] } }, timing: 'snappy' } })
        await client.callTool({ name: 'set_pose', arguments: { frame: 9, goals: { right_hand: { view: [-0.35, -0.3, 1.65], pole: [2.6, 1.5, 0.6] } }, timing: 'floaty' } })
        await client.callTool({ name: 'copy_pose_to_frame', arguments: { from_frame: 0, to_frame: 20 } })
        const fp = await client.callTool({ name: 'preview', arguments: { frames: 'keys', views: ['first_person', 'side'] } })
        assert(!fp.isError, `first-person preview failed: ${text(fp)}`)
        writeFileSync(join(out, 'mcp-first-person-preview.png'), Buffer.from(fp.content.find((c) => c.type === 'image').data, 'base64'))
        const vis = json(fp).first_person_visibility.first_person
        assert(/in view/.test(vis.f0.right_hand) && /in view/.test(vis.f9.right_hand), `hands should be in the first-person picture: ${JSON.stringify(vis)}`)
        await page.keyboard.press('v')
        await sleep(500)
        await shot(page, '02b-first-person-viewport')
        await page.keyboard.press('Escape')
        ok('first-person posing by picture position, preview and viewport toggle')
        await client.close()

        // stdio launcher proxies to the same server
        const stdio = new Client({ name: 'inbetween-e2e-stdio', version: '1.0.0' })
        await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'out', 'launcher', 'inbetween-mcp.cjs'), join(userData, 'mcp-runtime.json')] }))
        const viaStdio = (await stdio.listTools()).tools.length
        assert(viaStdio === tools.length, 'stdio launcher lists a different tool set')
        const clips = json(await stdio.callTool({ name: 'list_clips', arguments: {} }))
        assert(clips.clips.some((c) => c.name === 'Wave'), 'stdio launcher did not reach the running app')
        await stdio.close()
        ok('stdio launcher proxies to the running app', `${viaStdio} tools`)
      }

      if (want('manual')) {
        console.log('manual controls')
        const { client } = await mcpConnect(userData)
        await client.callTool({ name: 'create_clip', arguments: { name: 'Manual', length: 30 } })
        await client.callTool({ name: 'set_pose', arguments: { frame: 0 } })
        await client.callTool({ name: 'set_pose', arguments: { frame: 20, bones: { Head: { rotation: [0, 30, 0] } } } })
        await sleep(300)
        const box = await page.locator('.viewport canvas').boundingBox()
        const chat = await page.locator('.chat').boundingBox()
        const cx = (box.x + (chat ? chat.x : box.x + box.width)) / 2, cy = box.y + box.height * 0.5

        // play / pause / scrub / speed / loop
        await page.keyboard.press('Space')
        await sleep(350)
        const playingFrame = await page.evaluate(() => Number(document.querySelector('.readout b').textContent))
        await page.keyboard.press('Space')
        assert(playingFrame > 0, 'playback did not advance the playhead')
        const track = await page.locator('.track').boundingBox()
        await page.mouse.click(track.x + track.width * 0.5, track.y + 12)
        const scrubbed = await page.evaluate(() => Number(document.querySelector('.readout b').textContent))
        assert(Math.abs(scrubbed - 15) <= 1, `scrub landed on frame ${scrubbed}, expected about 15`)
        await page.keyboard.press('ArrowRight')
        assert((await page.evaluate(() => Number(document.querySelector('.readout b').textContent))) === scrubbed + 1, 'arrow key did not step a frame')
        await page.locator('.transport .speed').click()
        assert((await page.locator('.transport .speed').textContent()) === '2×', 'speed button did not change speed')
        await page.locator('button[aria-label="Loop"]').click()
        await sleep(150)
        assert((await docOf(page)).project.clips.find((c) => c.name === 'Manual').loop === true, 'loop toggle did not set the clip loop flag')
        ok('play, pause, scrub, frame step, speed and loop')

        // orbit changes the camera (image changes), zoom works
        const before = await page.locator('.viewport canvas').screenshot()
        await page.mouse.move(cx - 200, cy + 150)
        await page.mouse.down()
        await page.mouse.move(cx - 80, cy + 120, { steps: 6 })
        await page.mouse.up()
        await page.mouse.wheel(0, -240)
        await sleep(500)
        const after = await page.locator('.viewport canvas').screenshot()
        assert(!before.equals(after), 'orbit/zoom did not change the view')
        ok('orbit and zoom')
        await page.keyboard.press('f')
        await sleep(500)

        // select a bone by clicking it, then rotate with the gizmo
        await page.mouse.click(track.x + PADX(track, 20, 30), track.y + 12)
        const pos = await page.evaluate(() => window.__inbetweenTest.project('UpperTorso'))
        await page.mouse.click(pos.x, pos.y)
        await sleep(250)
        const pill = await page.locator('.selection-pill').textContent()
        assert(/Torso|Arm|Head/.test(pill ?? ''), `clicking the torso selected "${pill}"`)
        await shot(page, '03-bone-selected')
        ok('click selects a bone', pill.replace(/drag.*/, '').trim())
        const sel = await page.evaluate(() => window.__inbetweenTest.selected())
        const ring = await page.evaluate(() => window.__inbetweenTest.gizmoHandle())
        const undoCount = async () => (await docOf(page)).version
        const v0 = await undoCount()
        await page.mouse.move(ring.x, ring.y)
        await page.mouse.down()
        await page.mouse.move(ring.x + 30, ring.y + 46, { steps: 8 })
        await page.mouse.up()
        await sleep(350)
        const d1 = await docOf(page)
        const manual = d1.project.clips.find((c) => c.name === 'Manual')
        const key = manual.tracks.r15[sel].find((k) => k.frame === 20)
        assert(d1.version > v0 && key, 'gizmo drag did not write a key')
        assert(Math.abs(key.q[3]) < 0.99999, 'gizmo drag did not rotate the bone')
        await shot(page, '04-after-gizmo')
        ok('rotate gizmo writes a key', `${sel} @20`)

        // IK handle drag
        const hand = await page.evaluate(() => window.__inbetweenTest.handle('left_hand'))
        await page.mouse.click(hand.x, hand.y)
        await sleep(250)
        assert(/left hand target/.test((await page.locator('.selection-pill').textContent()) ?? ''), 'IK handle was not selected')
        const arrow = await page.evaluate(() => window.__inbetweenTest.gizmoHandle())
        await page.mouse.move(arrow.x, arrow.y)
        await page.mouse.down()
        await page.mouse.move(arrow.x + 10, arrow.y - 70, { steps: 8 })
        await page.mouse.up()
        await sleep(350)
        const d2 = await docOf(page)
        const arm = d2.project.clips.find((c) => c.name === 'Manual').tracks.r15.LeftUpperArm.find((k) => k.frame === 20)
        assert(arm && Math.abs(arm.q[3]) < 0.9999, 'IK handle drag did not pose the arm')
        await shot(page, '05-after-ik-drag')
        ok('IK handle drag poses the arm')

        // timeline: move, copy, easing, delete
        await page.keyboard.press('Escape')
        const pip = page.locator('.pip[data-frame="20"]')
        const pb = await pip.boundingBox()
        const perFrame = (track.width - 28) / 30
        await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2)
        await page.mouse.down()
        await page.mouse.move(pb.x + pb.width / 2 + perFrame * 4, pb.y + pb.height / 2, { steps: 5 })
        await page.mouse.up()
        await sleep(300)
        let frames = Object.values((await docOf(page)).project.clips.find((c) => c.name === 'Manual').tracks.r15).flatMap((k) => k.map((x) => x.frame))
        assert(frames.includes(24) && !frames.includes(20), `moving a key 20 -> 24 failed (frames: ${[...new Set(frames)]})`)
        ok('drag moves a keyframe')
        await page.locator('.pip[data-frame="24"]').click()
        await sleep(200)
        await page.locator('.key-menu button', { hasText: 'ease:' }).click()
        await shot(page, '06-easing-menu')
        await page.locator('.key-menu button', { hasText: 'snappy' }).click()
        await sleep(250)
        let m = (await docOf(page)).project.clips.find((c) => c.name === 'Manual')
        assert(m.tracks.r15.Head.find((k) => k.frame === 24).ease === 'cubic', 'easing menu did not change easing')
        ok('easing menu changes easing')
        await page.evaluate(() => window.__inbetweenTest.setFrame(10, [24]))
        await page.locator('.key-menu button', { hasText: 'copy to playhead' }).click()
        await sleep(250)
        m = (await docOf(page)).project.clips.find((c) => c.name === 'Manual')
        assert(m.tracks.r15.Head.some((k) => k.frame === 10) && m.tracks.r15.Head.some((k) => k.frame === 24), 'copy to playhead failed')
        ok('copy keyframes')
        await page.evaluate(() => window.__inbetweenTest.setFrame(10, [10]))
        await page.locator('.key-menu button', { hasText: 'delete' }).click()
        await sleep(250)
        m = (await docOf(page)).project.clips.find((c) => c.name === 'Manual')
        assert(!m.tracks.r15.Head.some((k) => k.frame === 10), 'delete keys failed')
        ok('delete keyframes')

        // undo / redo through the UI
        const vBefore = (await docOf(page)).project.clips.find((c) => c.name === 'Manual').tracks.r15.Head.length
        await page.locator('button[aria-label="Undo"]').click()
        await sleep(200)
        const vUndo = (await docOf(page)).project.clips.find((c) => c.name === 'Manual').tracks.r15.Head.length
        await page.locator('button[aria-label="Redo"]').click()
        await sleep(200)
        const vRedo = (await docOf(page)).project.clips.find((c) => c.name === 'Manual').tracks.r15.Head.length
        assert(vUndo === vBefore + 1 && vRedo === vBefore, `undo/redo mismatch (${vBefore}, ${vUndo}, ${vRedo})`)
        ok('undo and redo')

        // the AI is told about the manual edits on its next call
        const note = text(await client.callTool({ name: 'list_clips', arguments: {} }))
        assert(/NOTE: the user made manual edits/.test(note) && /dragged left_hand/.test(note) && /moved keys/.test(note), `AI was not told about manual edits: ${note.slice(-400)}`)
        ok('AI is told what the user changed by hand')
        await client.close()
      }

      if (want('export')) {
        console.log('export')
        const { client } = await mcpConnect(userData)
        const clips = json(await client.callTool({ name: 'list_clips', arguments: {} }))
        if (!clips.clips.some((c) => c.key_frames > 1)) {
          await client.callTool({ name: 'set_pose', arguments: { frame: 0 } })
          await client.callTool({ name: 'set_pose', arguments: { frame: 15, goals: { right_hand: { position: [1.6, 4.6, -1] } } } })
          await client.callTool({ name: 'set_pose', arguments: { frame: 30, from: 'rest' } })
        }
        for (const [format, extra] of [['rbxmx', {}], ['glb', {}], ['mp4', { width: 640, height: 360 }], ['gif', { width: 320, height: 320, background: 'transparent', fps: 15 }], ['webm', { width: 320, height: 320, background: 'transparent' }]]) {
          const path = join(userData, `out.${format}`)
          const res = await client.callTool({ name: 'export', arguments: { format, path, ...extra } }, undefined, { timeout: 180000 })
          assert(!res.isError, `${format} export failed: ${text(res)}`)
          assert(existsSync(path) && statSync(path).size > 500, `${format} file missing or empty`)
          const head = readFileSync(path).subarray(0, 12)
          const sig = { rbxmx: () => head.toString().startsWith('<roblox'), glb: () => head.subarray(0, 4).toString() === 'glTF', mp4: () => head.subarray(4, 8).toString() === 'ftyp', gif: () => head.subarray(0, 3).toString() === 'GIF', webm: () => head[0] === 0x1a && head[1] === 0x45 }[format]()
          assert(sig, `${format} file has the wrong signature`)
          ok(`export ${format}`, `${Math.round(statSync(path).size / 1024)} KB`)
        }
        await client.close()
      }
      assert(!errors.length, `renderer console errors:\n${errors.join('\n')}`)
      ok('no renderer errors')
    } finally {
      await app.close().catch(() => undefined)
    }
  }

  // ============================================================== 2. built-in agent vs mock API
  if (want('agent')) {
    console.log('agent (mocked Claude API)')
    const mock = await startMock()
    const { app, page, errors } = await launch([`--mock-api=${mock.url}`])
    try {
      await page.locator('.composer textarea').fill('Make the character nod')
      await page.keyboard.press('Enter')
      await page.waitForSelector('.chip', { timeout: 15000 })
      await shot(page, '07-agent-streaming')
      await page.waitForFunction(() => /Done\. A/.test(document.querySelector('.chat-scroll')?.textContent ?? ''), null, { timeout: 30000 })
      await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 10000 })
      await sleep(500)
      const chips = await page.locator('.chat .chip').allTextContents()
      assert(chips.some((c) => /posing frame 10/.test(c)) && chips.some((c) => /previewing/.test(c)) && chips.some((c) => /checking/.test(c)), `unexpected chips: ${chips}`)
      assert((await page.locator('.chat .thumb').count()) === 1, 'preview thumbnail missing from chat')
      const usage = await page.locator('.chat .usage').allTextContents()
      assert(usage.length === 3 && /tokens in, \d+ out/.test(usage[0]), `usage labels wrong: ${usage}`)
      const doc = await docOf(page)
      const nod = doc.project.clips.find((c) => c.name === 'Nod')
      assert(nod && nod.tracks.r15.Head.length === 3, 'agent tool calls did not edit the document')
      // Request shape: the three requests carry tools, adaptive thinking at medium effort, and the tool results with the preview image.
      const [r1, r2, r3] = mock.state.requests.map((r) => r.body)
      assert(r1.thinking?.type === 'adaptive' && r1.output_config?.effort === 'medium', 'thinking/effort not set as intended')
      assert(r1.tools.length > 15 && r1.stream === true, 'tools or streaming missing from the request')
      assert(/Block the key poses/.test(typeof r1.system === 'string' ? r1.system : JSON.stringify(r1.system)), 'system prompt is missing the workflow')
      const results = r3.messages[r3.messages.length - 1].content
      assert(results.some((c) => c.type === 'tool_result' && c.content.some((b) => b.type === 'image')), 'preview image was not returned to the model')
      assert(r2.messages[2].content.filter((c) => c.type === 'tool_result').length === 4, 'tool results were not batched into one user message')
      assert(mock.state.requests[0].headers['x-api-key'], 'API key header missing')
      await shot(page, '08-agent-done')
      ok('agent loop: streaming text, tool chips, live document edits, preview image, usage', `${mock.state.requests.length} requests`)

      // manual edit is reported on the next turn
      await page.evaluate(() => window.inbetween.command({ type: 'deleteKeys', frames: [10] }))
      await page.locator('.composer textarea').fill('thanks')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => !document.querySelector('.send.stop') && document.querySelectorAll('.msg.user').length === 2, null, { timeout: 15000 })
      await sleep(600)
      const lastUser = mock.state.requests[mock.state.requests.length - 1].body.messages.filter((m) => m.role === 'user').pop()
      assert(JSON.stringify(lastUser).includes('deleted keys'), 'manual edit note missing from the next agent turn')
      ok('agent is told about manual edits on its next turn')

      mock.state.mode = 'auth'
      await page.locator('.composer textarea').fill('again')
      await page.keyboard.press('Enter')
      await page.waitForSelector('.msg.error', { timeout: 15000 })
      assert(/rejected the API key/.test(await page.locator('.msg.error').last().textContent()), 'bad-key error not shown clearly')
      await shot(page, '09-agent-error')
      ok('bad API key shows a clear error')
      mock.state.mode = 'rate'
      await page.locator('.msg.error button', { hasText: 'Open Settings' }).last().waitFor()
      await page.locator('.composer textarea').fill('once more')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => /Rate limited/.test([...document.querySelectorAll('.msg.error')].pop()?.textContent ?? ''), null, { timeout: 20000 })
      ok('rate limit shows a clear error with retry')
      mock.server.close()
      mock.server.closeAllConnections?.()
      await sleep(200)
      await page.locator('.msg.error button', { hasText: 'Retry' }).last().click()
      await page.waitForFunction(() => /Could not reach the Claude API/.test([...document.querySelectorAll('.msg.error')].pop()?.textContent ?? ''), null, { timeout: 30000 })
      ok('network failure shows a clear error')
      assert(!errors.length, `renderer console errors:\n${errors.join('\n')}`)
    } finally {
      await app.close().catch(() => undefined)
      mock.server.close()
    }
  }

  // ============================================================== 3. themes
  if (want('themes')) {
    console.log('themes')
    const { app, page, userData } = await launch()
    try {
      const { client } = await mcpConnect(userData)
      await client.callTool({ name: 'set_pose', arguments: { frame: 0, timing: 'floaty' } })
      await client.callTool({ name: 'set_pose', arguments: { frame: 12, hips: { position: [0, -0.5, 0], rotation: [0, -25, 0] }, goals: { right_hand: { position: [1.0, 4.4, -1.8] }, left_hand: { position: [-1.2, 3.6, 0.3] } }, timing: 'snappy' } })
      await client.callTool({ name: 'set_pose', arguments: { frame: 30, from: 'rest' } })
      await client.callTool({ name: 'add_contact', arguments: { chain: 'left_foot', start: 0, end: 30 } })
      await client.callTool({ name: 'add_marker', arguments: { name: 'hit', frame: 12 } })
      await client.close()
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => window.inbetween.setSettings({ theme: t }), theme)
        await sleep(700)
        assert((await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `theme ${theme} not applied`)
        await shot(page, `10-theme-${theme}`)
        await page.locator('button[aria-label="Settings"]').click()
        await sleep(450)
        await shot(page, `11-settings-${theme}`)
        await page.keyboard.press('Escape')
        await page.locator('button[aria-label="Export"]').click()
        await sleep(450)
        await page.locator('.choice button', { hasText: 'MP4' }).click()
        await sleep(200)
        await shot(page, `12-export-${theme}`)
        await page.keyboard.press('Escape')
        await sleep(300)
      }
      ok('light and dark themes render')
    } finally {
      await app.close().catch(() => undefined)
    }
  }
}

function PADX(track, frame, length) {
  return 14 + ((track.width - 28) * frame) / length
}

run().then(() => {
  console.log(`\n${results.length} checks passed. Screenshots in test-results/.`)
  process.exit(0)
}).catch((err) => {
  console.error(`\nFAILED: ${err.stack ?? err}`)
  process.exit(1)
})
