import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The same workflow text ships three ways: agent system prompt, MCP server instructions, and SKILL.md.
describe('workflow text', () => {
  const workflow = readFileSync(join(__dirname, '../src/core/workflow.md'), 'utf8')
  it('SKILL.md carries the workflow verbatim under valid frontmatter', () => {
    const skill = readFileSync(join(__dirname, '../SKILL.md'), 'utf8')
    expect(skill.startsWith('---\nname: inbetween-animation\n')).toBe(true)
    expect(skill).toMatch(/\ndescription: .{40,}\n---\n/)
    expect(skill.endsWith(workflow)).toBe(true)
  })
  it('covers the required steps and recipes', () => {
    for (const needle of ['Read the rig first', 'Block the key poses', 'Preview and look', 'breakdowns', 'Anticipation', 'Check, fix, preview again', 'Do not call it done until you have looked',
      'Combat and abilities', 'Movement cycles', 'Emotes and cutscenes', 'Props', 'First-person animation']) expect(workflow).toContain(needle)
  })
})
