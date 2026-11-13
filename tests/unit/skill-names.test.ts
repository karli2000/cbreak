import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS = join(import.meta.dir, '../../plugin/skills')

// A skill named like the mod's command takes the name over: `/coffee setup` then opened the help
// skill instead of the command (plugin 0.2.0-0.2.3).
test('no skill is named like the /coffee command', () => {
  for (const dir of readdirSync(SKILLS)) {
    const md = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8')
    const name = /^name:\s*(.+)$/m.exec(md)?.[1]?.trim()
    expect(dir).not.toBe('coffee')
    expect(name).not.toBe('coffee')
    expect(name).toBe(dir)
  }
})
