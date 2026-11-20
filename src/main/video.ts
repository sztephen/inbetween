import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** Bundled ffmpeg for this platform/arch, falling back to one on PATH. */
export function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    join(process.resourcesPath ?? '', 'ffmpeg', exe),
    join(app.getAppPath(), 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe),
    join(process.cwd(), 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe),
    // Apps started from Finder/Dock do not get the shell's PATH, so look in the usual install places too.
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'])
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return exe
}

export interface EncodeOptions {
  format: 'mp4' | 'gif' | 'webm'
  path: string
  width: number
  height: number
  fps: number
  transparent: boolean
}

export function encoderArgs(o: EncodeOptions): string[] {
  const input = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0', '-an']
  if (o.format === 'mp4') return [...input, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', o.path]
  if (o.format === 'webm') return [...input, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-pix_fmt', o.transparent ? 'yuva420p' : 'yuv420p', o.path]
  const palette = o.transparent
    ? '[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128'
    : '[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse'
  return [...input, '-filter_complex', palette, '-loop', '0', o.path]
}

export class RenderCancelled extends Error {
  constructor() {
    super('Render cancelled.')
  }
}

/**
 * Streams raw RGBA frames into ffmpeg. `nextFrame` returns null when done.
 * Never hangs on a dead encoder: every wait also ends when ffmpeg exits or `signal` aborts.
 * A cancelled or failed render removes its partial output file.
 */
export async function encodeVideo(o: EncodeOptions, nextFrame: (index: number) => Promise<Uint8Array | null>, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw new RenderCancelled()
  mkdirSync(dirname(o.path), { recursive: true })
  const bin = ffmpegPath()
  const proc = spawn(bin, encoderArgs(o), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000)
  })
  let exited = false
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (e: NodeJS.ErrnoException) => {
      exited = true
      reject(e.code === 'ENOENT'
        ? new Error('ffmpeg was not found. Install it (for example "brew install ffmpeg") or run "npm run ffmpeg" in the project, then try again.')
        : e)
    })
    proc.on('close', (code, sig) => {
      exited = true
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg failed (${code !== null ? `exit ${code}` : sig}): ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ') || 'no output'}`))
    })
  })
  done.catch(() => undefined)
  // Resolves (never rejects) when the encoder is gone or the render is cancelled, to race against waits.
  const interrupted = new Promise<'ended'>((resolve) => {
    done.then(() => resolve('ended'), () => resolve('ended'))
    signal?.addEventListener('abort', () => resolve('ended'), { once: true })
  })
  proc.stdin.on('error', () => undefined)
  const check = async (): Promise<void> => {
    if (signal?.aborted) throw new RenderCancelled()
    if (exited) {
      await done
      throw new Error('ffmpeg stopped before the video was finished.')
    }
  }
  let count = 0
  try {
    for (;;) {
      await check()
      const frame = await Promise.race([nextFrame(count), interrupted])
      await check()
      if (frame === 'ended') continue
      if (!frame) break
      if (frame.byteLength !== o.width * o.height * 4) throw new Error(`Renderer returned a frame of the wrong size (${frame.byteLength} bytes).`)
      const ok = proc.stdin.write(frame)
      if (!ok) await Promise.race([new Promise<void>((r) => proc.stdin.once('drain', () => r())), interrupted])
      count++
    }
    proc.stdin.end()
    await Promise.race([done, interrupted])
    if (signal?.aborted) throw new RenderCancelled()
    await done
    return count
  } catch (e) {
    if (!exited) proc.kill('SIGKILL')
    proc.stdin.destroy()
    try {
      rmSync(o.path, { force: true })
    } catch { /* partial file */ }
    throw e
  }
}
