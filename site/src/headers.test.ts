import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const dist = join(root, 'dist')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe('security headers', () => {
  test('public/_headers has the CSP and friends', () => {
    const p = join(root, 'public/_headers')
    expect(existsSync(p)).toBe(true)
    const h = readFileSync(p, 'utf8')
    expect(h).toContain(
      "connect-src 'self' https://meioekkvutvrspfvqgye.supabase.co wss://meioekkvutvrspfvqgye.supabase.co",
    )
    expect(h).toContain("frame-ancestors 'none'")
    expect(h).toContain("script-src 'self'")
    expect(h).toContain('X-Content-Type-Options: nosniff')
    expect(h).toContain('Referrer-Policy: no-referrer')
    expect(h).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=()')
  })
})

describe('build output', () => {
  beforeAll(() => {
    const r = Bun.spawnSync(['bunx', 'vite', 'build'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) console.error(r.stdout.toString(), r.stderr.toString())
    expect(r.exitCode).toBe(0)
  }, 120_000)

  test('dist/_headers exists', () => {
    expect(existsSync(join(dist, '_headers'))).toBe(true)
  })

  test('no file in dist mentions the service role key', () => {
    for (const f of files(dist)) {
      const t = readFileSync(f, 'utf8')
      expect(t.includes('service_role')).toBe(false)
      expect(t.includes('SUPABASE_SERVICE_ROLE_KEY')).toBe(false)
    }
  })

  test('index.html has no inline script or style (CSP)', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    expect(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)).toBe(false)
    expect(/<style[\s>]/i.test(html)).toBe(false)
    expect(/\sstyle=/i.test(html)).toBe(false)
    expect(/\son[a-z]+=/i.test(html)).toBe(false)
  })
})
