// GLB container reading/writing. Only what Inbetween needs: one JSON chunk and one BIN chunk.

export interface Gltf {
  asset: { version: string; generator?: string }
  scene?: number
  scenes?: { nodes?: number[]; name?: string }[]
  nodes?: GltfNode[]
  skins?: { joints: number[]; skeleton?: number; inverseBindMatrices?: number; name?: string }[]
  meshes?: unknown[]
  materials?: unknown[]
  accessors?: GltfAccessor[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }[]
  buffers?: { byteLength: number; uri?: string }[]
  animations?: GltfAnimation[]
  [k: string]: unknown
}
export interface GltfNode {
  name?: string
  children?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  matrix?: number[]
  mesh?: number
  skin?: number
  [k: string]: unknown
}
export interface GltfAccessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  count: number
  type: string
  min?: number[]
  max?: number[]
  normalized?: boolean
}
export interface GltfAnimation {
  name?: string
  channels: { sampler: number; target: { node?: number; path: string } }[]
  samplers: { input: number; output: number; interpolation?: string }[]
}

const MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

export function parseGlb(bytes: Uint8Array): { json: Gltf; bin: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength >= 12 && dv.getUint32(0, true) === MAGIC) {
    if (dv.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 (.glb version 2) is supported.')
    let off = 12
    let json: Gltf | undefined
    let bin: Uint8Array = new Uint8Array(0)
    while (off + 8 <= bytes.byteLength) {
      const len = dv.getUint32(off, true)
      const type = dv.getUint32(off + 4, true)
      const chunk = bytes.subarray(off + 8, off + 8 + len)
      if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf
      else if (type === BIN_CHUNK && bin.byteLength === 0) bin = chunk
      off += 8 + len
    }
    if (!json) throw new Error('This .glb has no JSON chunk.')
    return { json, bin }
  }
  // Plain .gltf JSON with an embedded base64 buffer.
  let json: Gltf
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as Gltf
  } catch {
    throw new Error('Not a glTF file: expected a .glb or .gltf.')
  }
  if (!json.asset) throw new Error('Not a glTF file: missing "asset".')
  const uri = json.buffers?.[0]?.uri
  if (uri && !uri.startsWith('data:')) throw new Error('This .gltf references an external .bin file. Export it as a single .glb (binary) and import that instead.')
  let bin: Uint8Array = new Uint8Array(0)
  if (uri) {
    const b64 = uri.slice(uri.indexOf(',') + 1)
    const raw = atob(b64)
    bin = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i)
    delete json.buffers![0].uri
  }
  return { json, bin }
}

export function buildGlb(json: Gltf, bin: Uint8Array): Uint8Array {
  const pad4 = (n: number): number => (n + 3) & ~3
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jl = pad4(jsonBytes.byteLength), bl = pad4(bin.byteLength)
  const total = 12 + 8 + jl + (bl ? 8 + bl : 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jl, true)
  dv.setUint32(16, JSON_CHUNK, true)
  out.fill(0x20, 20, 20 + jl)
  out.set(jsonBytes, 20)
  if (bl) {
    dv.setUint32(20 + jl, bl, true)
    dv.setUint32(24 + jl, BIN_CHUNK, true)
    out.set(bin, 28 + jl)
  }
  return out
}

/** Read a float accessor (SCALAR/VEC3/VEC4) into a flat number array. */
export function readFloats(json: Gltf, bin: Uint8Array, accessorIndex: number): number[] {
  const acc = json.accessors![accessorIndex]
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type] ?? 1
  if (acc.componentType !== 5126) throw new Error('Only float animation accessors are supported.')
  const bv = json.bufferViews![acc.bufferView!]
  const stride = bv.byteStride ?? comps * 4
  const base = bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const dv = new DataView(bin.buffer, base)
  const out: number[] = []
  for (let i = 0; i < acc.count; i++) for (let c = 0; c < comps; c++) out.push(dv.getFloat32(i * stride + c * 4, true))
  return out
}

/** Growable binary buffer that hands out bufferViews/accessors, 4-byte aligned. */
export class BinWriter {
  private chunks: Uint8Array[] = []
  length = 0
  constructor(private json: Gltf, initial?: Uint8Array) {
    if (initial?.byteLength) {
      this.chunks.push(initial)
      this.length = initial.byteLength
      this.align()
    }
    json.bufferViews ??= []
    json.accessors ??= []
  }
  private align(): void {
    const padLen = ((this.length + 3) & ~3) - this.length
    if (padLen) {
      this.chunks.push(new Uint8Array(padLen))
      this.length += padLen
    }
  }
  private push(data: ArrayBufferView, target?: number): number {
    this.align()
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...(target ? { target } : {}) }
    this.chunks.push(bytes.slice())
    this.length += bytes.byteLength
    this.json.bufferViews!.push(view)
    return this.json.bufferViews!.length - 1
  }
  floats(values: number[], type: 'SCALAR' | 'VEC3' | 'VEC4', withMinMax = false, target?: number): number {
    const arr = new Float32Array(values)
    const comps = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4
    const acc: GltfAccessor = { bufferView: this.push(arr, target), componentType: 5126, count: values.length / comps, type }
    if (withMinMax) {
      const min = new Array(comps).fill(Infinity), max = new Array(comps).fill(-Infinity)
      for (let i = 0; i < arr.length; i++) {
        const c = i % comps
        if (arr[i] < min[c]) min[c] = arr[i]
        if (arr[i] > max[c]) max[c] = arr[i]
      }
      acc.min = min
      acc.max = max
    }
    this.json.accessors!.push(acc)
    return this.json.accessors!.length - 1
  }
  indices(values: number[]): number {
    const acc: GltfAccessor = { bufferView: this.push(new Uint16Array(values), 34963), componentType: 5123, count: values.length, type: 'SCALAR' }
    this.json.accessors!.push(acc)
    return this.json.accessors!.length - 1
  }
  finish(): Uint8Array {
    this.align()
    const out = new Uint8Array(this.length)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.byteLength
    }
    this.json.buffers = [{ byteLength: out.byteLength }]
    return out
  }
}
