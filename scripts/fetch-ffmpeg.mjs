// Downloads a static ffmpeg build for each requested platform into vendor/ffmpeg/<platform>-<arch>/.
// The binaries come from the @ffmpeg-installer npm packages (one package per platform/arch),
// fetched with `npm pack` so builds for other platforms can be bundled from any machine.
// This is never run automatically on install; it runs when you ask for it or build an installer.
//   npm run ffmpeg                                      (this machine)
//   node scripts/fetch-ffmpeg.mjs darwin-arm64 darwin-x64 win32-x64
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-ia32', 'linux-x64', 'linux-arm64']
let targets = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (process.argv.includes('--current') || !targets.length) targets = [`${process.platform}-${process.arch}`]
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let failed = false
for (const target of targets) {
  const exe = target.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg'
  const dest = join(root, 'vendor', 'ffmpeg', target, exe)
  if (existsSync(dest)) {
    console.log(`ffmpeg ${target}: already present`)
    continue
  }
  if (!SUPPORTED.includes(target)) {
    console.warn(`ffmpeg ${target}: no bundled build for this platform; video export will use ffmpeg from PATH.`)
    continue
  }
  const tmp = mkdtempSync(join(tmpdir(), 'inbetween-ffmpeg-'))
  try {
    execFileSync(npm, ['pack', `@ffmpeg-installer/${target}`, '--pack-destination', tmp, '--silent'], { stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack produced no tarball')
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(tmp, 'package', exe), dest)
    if (!target.startsWith('win32')) chmodSync(dest, 0o755)
    console.log(`ffmpeg ${target}: installed to ${dest}`)
  } catch (err) {
    failed = true
    console.warn(`ffmpeg ${target}: download failed (${err.message}).`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
process.exit(failed ? 1 : 0)
