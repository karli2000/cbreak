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
      "connect-src 'self' https://meioekkvutvrspfvqgye.supabase.co wss://meioekkvutvrspfvqgye.supabase.co https://api.github.com",
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
    // A production build must never pick up dev overrides exported in the shell.
    const env = { ...process.env }
    delete env.VITE_SUPABASE_URL
    delete env.VITE_SUPABASE_ANON_KEY
    const r = Bun.spawnSync(['bunx', 'vite', 'build'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
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

  test('the bundle points at the hosted backend, not a local stack', () => {
    const js = files(dist)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    expect(js).toContain('https://meioekkvutvrspfvqgye.supabase.co')
    expect(js.includes('127.0.0.1:54321')).toBe(false)
    expect(js.includes('localhost:54321')).toBe(false)
  })

  test('index.html has no inline script or style (CSP)', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    expect(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)).toBe(false)
    expect(/<style[\s>]/i.test(html)).toBe(false)
    expect(/\sstyle=/i.test(html)).toBe(false)
    expect(/\son[a-z]+=/i.test(html)).toBe(false)
  })
})
