// The committed helper bundle (plugin/dist/coffeebreakd.js) must equal a fresh build of the helper
// source, so a stale bundle never ships. Rebuild it with `bun run helper:bundle`.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUNDLE_PATH, bundleHeader, bundleHelper } from '../../scripts/bundle-helper.ts'

const REPO = resolve(import.meta.dir, '../..')
const tmp = mkdtempSync(join(tmpdir(), 'cb-bundle-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('helper bundle', () => {
  test('committed bundle matches a fresh build', async () => {
    const committed = Buffer.from(await Bun.file(join(REPO, BUNDLE_PATH)).bytes())
    const [pragma, header = ''] = committed.toString('utf8').split('\n', 2)
    // Bun skips transpiling only with `// @bun` on line 1
    expect(pragma).toBe('// @bun')
    const m = /^\/\/ coffeebreakd bundle, built with bun (\S+)$/.exec(header)
    if (!m) throw new Error(`${BUNDLE_PATH} has no build header: run bun run helper:bundle`)
    if (m[1] !== Bun.version) throw new Error(`bundle was built with bun ${m[1]}, you have ${Bun.version}: run bun run helper:bundle`)

    const out = join(tmp, 'coffeebreakd.js')
    await bundleHelper(out)
    const fresh = Buffer.from(await Bun.file(out).bytes())
    expect(fresh.toString('utf8').split('\n', 2)).toEqual(['// @bun', bundleHeader()])
    expect(bundleHeader()).toBe(`// coffeebreakd bundle, built with bun ${Bun.version}`)
    if (!fresh.equals(committed)) throw new Error(`${BUNDLE_PATH} differs from a fresh build: run bun run helper:bundle`)
  }, 60_000)

  test('bundle holds no local absolute paths', async () => {
    const text = await Bun.file(join(REPO, BUNDLE_PATH)).text()
    for (const local of [REPO, homedir(), '/home/', '/Users/']) expect(text.includes(local)).toBe(false)
  })
})
