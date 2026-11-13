import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDirFor } from '../../plugin/helper/data-dir'

const roots: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cbreak-dd-'))
  roots.push(d)
  return d
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('CBREAK_DATA_DIR wins and nothing is moved', () => {
  const cfg = temp()
  mkdirSync(join(cfg, 'coffeebreak'))
  expect(dataDirFor({ CBREAK_DATA_DIR: '/x/y', XDG_CONFIG_HOME: cfg }, '/home/u')).toBe('/x/y')
  expect(existsSync(join(cfg, 'coffeebreak'))).toBe(true)
})

test('the default is <config>/cbreak, XDG_CONFIG_HOME or ~/.config', () => {
  const cfg = temp()
  expect(dataDirFor({ XDG_CONFIG_HOME: cfg }, '/home/u')).toBe(join(cfg, 'cbreak'))
  const home = temp()
  expect(dataDirFor({}, home)).toBe(join(home, '.config', 'cbreak'))
})

test('an old coffeebreak folder is moved over, so the login survives the rename', () => {
  const cfg = temp()
  mkdirSync(join(cfg, 'coffeebreak'))
  writeFileSync(join(cfg, 'coffeebreak', 'auth.json'), '{"version":1}')
  expect(dataDirFor({ XDG_CONFIG_HOME: cfg }, '/home/u')).toBe(join(cfg, 'cbreak'))
  expect(readFileSync(join(cfg, 'cbreak', 'auth.json'), 'utf8')).toBe('{"version":1}')
  expect(existsSync(join(cfg, 'coffeebreak'))).toBe(false)
})

test('an existing cbreak folder is never overwritten', () => {
  const cfg = temp()
  mkdirSync(join(cfg, 'coffeebreak'))
  writeFileSync(join(cfg, 'coffeebreak', 'auth.json'), 'old')
  mkdirSync(join(cfg, 'cbreak'))
  writeFileSync(join(cfg, 'cbreak', 'auth.json'), 'new')
  expect(dataDirFor({ XDG_CONFIG_HOME: cfg }, '/home/u')).toBe(join(cfg, 'cbreak'))
  expect(readFileSync(join(cfg, 'cbreak', 'auth.json'), 'utf8')).toBe('new')
  expect(existsSync(join(cfg, 'coffeebreak'))).toBe(true)
})
