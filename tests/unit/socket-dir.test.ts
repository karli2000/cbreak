// The helper's socket directory: ours or a fresh private one, never something planted in /tmp.
import { expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socketBase, socketDir } from '../../plugin/helper/socket-dir'

const uid = process.getuid?.() ?? 0
const base = () => mkdtempSync(join(tmpdir(), 'cb-sockdir-'))
const mode = (p: string) => lstatSync(p).mode & 0o777

test('XDG_RUNTIME_DIR wins, then /run/user/<uid>, then the temp dir', () => {
  expect(socketBase({ XDG_RUNTIME_DIR: '/run/user/x' }, uid)).toBe('/run/user/x')
  const b = socketBase({}, uid)
  expect([`/run/user/${uid}`, tmpdir()]).toContain(b)
})

test('creates cbreak-<uid> with mode 700', () => {
  const b = base()
  const s = socketDir(b, uid)
  expect(s).toEqual({ dir: join(b, `cbreak-${uid}`), temporary: false })
  expect(mode(s.dir)).toBe(0o700)
  rmSync(b, { recursive: true, force: true })
})

test('accepts an existing directory of ours and tightens its mode', () => {
  const b = base()
  const dir = join(b, `cbreak-${uid}`)
  mkdirSync(dir, { mode: 0o755 })
  expect(socketDir(b, uid)).toEqual({ dir, temporary: false })
  expect(mode(dir)).toBe(0o700)
  rmSync(b, { recursive: true, force: true })
})

test('a symlink in its place is not followed: a private temp directory is used instead', () => {
  const b = base()
  const target = join(b, 'elsewhere')
  mkdirSync(target)
  symlinkSync(target, join(b, `cbreak-${uid}`))
  const s = socketDir(b, uid)
  expect(s.temporary).toBe(true)
  expect(s.dir.startsWith(join(tmpdir(), 'cbreak-'))).toBe(true)
  expect(s.dir).not.toBe(join(b, `cbreak-${uid}`))
  expect(mode(s.dir)).toBe(0o700)
  rmSync(s.dir, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('a directory owned by someone else is not used', () => {
  const b = base()
  mkdirSync(join(b, `cbreak-${uid + 1}`))
  const s = socketDir(b, uid + 1) // "someone else" = a uid that does not own the directory we made
  expect(s.temporary).toBe(true)
  rmSync(s.dir, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})
