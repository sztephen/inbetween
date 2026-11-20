import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { ProjectStore } from '@core/document'
import { buildTools } from '@core/tools'
import { ToolRegistry, type PreviewRequest, type ToolHost, type ToolResult } from '@core/tools/registry'

// 1x1 transparent PNG
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export function makeHarness(): { store: ProjectStore; registry: ToolRegistry; dir: string; previews: PreviewRequest[]; call: (name: string, args?: unknown) => Promise<any>; raw: (name: string, args?: unknown) => Promise<ToolResult> } {
  const dir = mkdtempSync(join(tmpdir(), 'inbetween-test-'))
  const previews: PreviewRequest[] = []
  const store = new ProjectStore()
  const host: ToolHost = {
    renderPreview: async (req) => {
      previews.push(req)
      return { mimeType: 'image/png', data: TINY_PNG }
    },
    renderVideo: async (req) => ({ path: req.path, frames: 0 }),
    writeFile: async (path, data) => {
      writeFileSync(path, data)
      return path
    },
    readFile: async (path) => new Uint8Array(readFileSync(path)),
    resolveExportPath: (name) => (isAbsolute(name) ? name : join(dir, name))
  }
  const registry = new ToolRegistry(store, host, buildTools())
  const raw = (name: string, args: unknown = {}): Promise<ToolResult> => registry.call(name, args, 'mcp', 'test')
  const call = async (name: string, args: unknown = {}): Promise<any> => {
    const res = await raw(name, args)
    if (res.isError) throw new Error(res.text)
    try {
      return JSON.parse(res.text.split('\n\nNOTE:')[0])
    } catch {
      return res.text
    }
  }
  return { store, registry, dir, previews, call, raw }
}
