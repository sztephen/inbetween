import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** Bundled ffmpeg for this platform/arch, falling back to one on PATH. */
export function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    join(process.resourcesPath ?? '', 'ffmpeg', exe),
    join(app.getAppPath(), 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe),
    join(process.cwd(), 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe)
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

/** Streams raw RGBA frames into ffmpeg. `nextFrame` returns null when done. */
export async function encodeVideo(o: EncodeOptions, nextFrame: (index: number) => Promise<Uint8Array | null>): Promise<number> {
  mkdirSync(dirname(o.path), { recursive: true })
  const bin = ffmpegPath()
  const proc = spawn(bin, encoderArgs(o), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000)
  })
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT'
      ? new Error('ffmpeg was not found. Run "npm run ffmpeg" in the project (development), or install ffmpeg and put it on your PATH.')
      : e))
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`))))
  })
  let failed: Error | null = null
  done.catch((e) => (failed = e))
  proc.stdin.on('error', () => undefined)
  let count = 0
  try {
    for (;;) {
      if (failed) break
      const frame = await nextFrame(count)
      if (!frame) break
      if (frame.byteLength !== o.width * o.height * 4) throw new Error(`Renderer returned a frame of the wrong size (${frame.byteLength} bytes).`)
      const ok = proc.stdin.write(frame)
      if (!ok) await new Promise<void>((r) => proc.stdin.once('drain', () => r()))
      count++
    }
  } catch (e) {
    proc.kill()
    throw e
  } finally {
    proc.stdin.end()
  }
  await done
  return count
}
