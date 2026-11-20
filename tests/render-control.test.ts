import { describe, expect, it } from 'vitest'
import { firstPersonRig } from '@core/clip'
import { parseProject, serializeProject } from '@core/document'
import { detectHead } from '@core/rigSetup'
import { defineTool } from '@core/tools/registry'
import { z } from 'zod'
import { makeHarness } from './helpers'

describe('render control and first person', () => {
  it('a concurrent tool runs while a long call holds the queue', async () => {
    const h = makeHarness()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    h.registry.register(defineTool({ name: 'slow', description: 'x'.repeat(50), schema: z.object({}), chip: () => 'slow', handler: async () => { await gate; return 'slow done' } }))
    h.registry.register(defineTool({ name: 'fast', description: 'x'.repeat(50), schema: z.object({}), chip: () => 'fast', concurrent: true, handler: () => 'fast done' }))
    const slow = h.raw('slow')
    const fast = await Promise.race([h.raw('fast'), new Promise<null>((r) => setTimeout(() => r(null), 500))])
    expect(fast?.text).toBe('fast done')
    release()
    expect((await slow).text).toBe('slow done')
  })

  it('cancel_render reports when nothing is rendering ', async () => {
    const h = makeHarness()
    expect(await h.call('cancel_render')).toMatchObject({ cancelled: false })
    expect(await h.call('cancel_render', { status_only: true })).toEqual({ rendering: false })
  })

  it('mcpOnly tools are marked in the listing', () => {
    const h = makeHarness()
    h.registry.register(defineTool({ name: 'ext', description: 'x'.repeat(50), schema: z.object({}), chip: () => 'e', mcpOnly: true, handler: () => 'ok' }))
    expect(h.registry.list().find((t) => t.name === 'ext')?.mcpOnly).toBe(true)
    expect(h.registry.list().find((t) => t.name === 'export')?.mcpOnly).toBeUndefined()
  })

  it('first person looks through a character when a prop is the active rig', async () => {
    const h = makeHarness()
    const r15 = h.store.project.rigs[0]
    const prop = await h.call('add_rig', { type: 'prop', preset: 'box', position: [4, 0, 0] })
    expect(h.store.project.activeRigId).toBe(prop.added.id)
    expect(firstPersonRig(h.store.project)?.id).toBe(r15.id)
    expect(firstPersonRig(h.store.project, prop.added.id)).toBeUndefined()
    // preview in first person without naming a rig uses the character
    await h.call('preview', { views: ['first_person'], frames: [0] })
    expect(h.previews.at(-1)?.subjectRigId).toBe(r15.id)
  })

  it('finds heads under common naming and backfills them on load', () => {
    const rig = (names: string[]): any => ({ bones: names.map((name) => ({ name })) })
    expect(detectHead(rig(['Hips', 'Spine', 'mixamorig:Head', 'mixamorig:HeadTop_End']))).toBe('mixamorig:Head')
    expect(detectHead(rig(['root', 'spine', 'Head_01', 'HeadTop_End']))).toBe('Head_01')
    expect(detectHead(rig(['Base', 'Lid']))).toBeUndefined()
    const h = makeHarness()
    const saved = JSON.parse(serializeProject(h.store.project))
    delete saved.rigs[0].head
    expect(parseProject(JSON.stringify(saved)).rigs[0].head).toBe('Head')
  })
})
