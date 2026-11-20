import type { EaseDir, EaseStyle } from './types'

// Easing between a key and the next. Directions use the standard meaning
// ('in' = starts slow, 'out' = ends slow); the Roblox exporter maps these to
// PoseEasingDirection, whose In/Out names are swapped relative to this.

const cubicIn = (t: number): number => t * t * t

function elasticIn(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const p = 0.3
  return -Math.pow(2, 10 * (t - 1)) * Math.sin(((t - 1 - p / 4) * (2 * Math.PI)) / p)
}

function bounceOut(t: number): number {
  const n = 7.5625, d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
const bounceIn = (t: number): number => 1 - bounceOut(1 - t)

function shape(fnIn: (t: number) => number, dir: EaseDir, t: number): number {
  if (dir === 'in') return fnIn(t)
  if (dir === 'out') return 1 - fnIn(1 - t)
  return t < 0.5 ? fnIn(t * 2) / 2 : 1 - fnIn((1 - t) * 2) / 2
}

/** Maps linear progress t in [0,1] to eased progress. 'constant' holds the first key until the next. */
export function ease(style: EaseStyle, dir: EaseDir, t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  switch (style) {
    case 'constant':
      return 0
    case 'linear':
      return t
    case 'cubic':
      return shape(cubicIn, dir, t)
    case 'elastic':
      return shape(elasticIn, dir, t)
    case 'bounce':
      return shape(bounceIn, dir, t)
  }
}

export const EASE_STYLES: EaseStyle[] = ['linear', 'constant', 'cubic', 'elastic', 'bounce']
export const EASE_DIRS: EaseDir[] = ['in', 'out', 'inout']

/** Timing presets exposed to the AI and the timeline menu. */
export const TIMING_PRESETS: Record<string, { ease: EaseStyle; dir: EaseDir; note: string }> = {
  linear: { ease: 'linear', dir: 'inout', note: 'constant speed; mechanical moves, cycle mid-sections' },
  snappy: { ease: 'cubic', dir: 'out', note: 'fast start that settles into the next pose; strikes, pops, quick gestures' },
  heavy: { ease: 'cubic', dir: 'in', note: 'slow start that accelerates into the next pose; wind-ups, heavy objects, falls' },
  floaty: { ease: 'cubic', dir: 'inout', note: 'slow in and slow out; idles, floating, gentle settles' },
  stepped: { ease: 'constant', dir: 'inout', note: 'hold this pose until the next key; blocking and held impact poses' },
  bouncy: { ease: 'bounce', dir: 'out', note: 'lands and bounces into the next pose' },
  springy: { ease: 'elastic', dir: 'out', note: 'overshoots and wobbles into the next pose' }
}
