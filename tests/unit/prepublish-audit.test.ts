import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'prepublish-audit.sh')
const dirs: string[] = []

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (role: string) => `eyJ${b64({ alg: 'HS256', typ: 'JWT' }).slice(3)}.${b64({ iss: 'supabase', role })}.${'s'.repeat(43)}`

function sh(cwd: string, cmd: string[]) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

function repo(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'audit-'))
  dirs.push(d)
  sh(d, ['git', 'init', '-q'])
  sh(d, ['git', 'config', 'user.email', 't@t']); sh(d, ['git', 'config', 'user.name', 't'])
  write(d, files)
  return d
}
function write(d: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true })
    writeFileSync(join(d, p), c)
  }
  sh(d, ['git', 'add', '-f', '-A']); sh(d, ['git', 'commit', '-q', '-m', 'x', '--allow-empty'])
}
const audit = (d: string, ...args: string[]) => sh(d, ['bash', SCRIPT, ...args])

afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('prepublish-audit', () => {
  test('clean repo passes', () => {
    expect(audit(repo({ 'a.txt': 'hello\n' })).code).toBe(0)
  })
  test('sb_secret_ key fails with file:line', () => {
    const r = audit(repo({ 'src/k.ts': `a\nconst k = '${'sb_' + 'secret_'}abcDEF123456789xyz'\n` }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('src/k.ts:2')
  })
  test('service_role JWT fails', () => {
    const r = audit(repo({ 'x.ts': `const k = '${jwt('service_role')}'\n` }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('x.ts:1')
  })
  test('anon JWT passes', () => {
    expect(audit(repo({ 'x.ts': `const k = '${jwt('anon')}'\n` })).code).toBe(0)
  })
  test('tracked .env and *.log fail', () => {
    const r = audit(repo({ '.env': 'A=1\n', 'logs/run.log': 'x\n' }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('.env')
    expect(r.out).toContain('logs/run.log')
  })
  test('token prefixes, private key and service-role env assignment fail', () => {
    const d = repo({
      'a.txt': `${'gh' + 'p_'}${'a'.repeat(36)}\n`,
      'b.txt': `${'sb' + 'p_'}${'0123456789abcdef'.repeat(3).slice(0, 40)}\n`,
      'c.txt': `-----BEGIN ${'RSA '}PRIVATE KEY-----\n`,
      'd.txt': `SUPABASE_SERVICE_ROLE_KEY=${'abcdefghijkl'}\n`,
      'e.txt': `${'github' + '_pat_'}${'A'.repeat(30)}\n`,
    })
    const r = audit(d)
    expect(r.code).toBe(1)
    for (const f of ['a.txt:1', 'b.txt:1', 'c.txt:1', 'd.txt:1', 'e.txt:1']) expect(r.out).toContain(f)
  })
  test('placeholder env assignment passes', () => {
    expect(audit(repo({ 'd.md': 'SUPABASE_SERVICE_ROLE_KEY=…\nSUPABASE_SERVICE_ROLE_KEY=$KEY\n' })).code).toBe(0)
  })
  test('--history finds a secret committed and later removed', () => {
    const d = repo({ 'k.ts': `const k = '${'sb_' + 'secret_'}abcDEF123456789xyz'\n` })
    write(d, { 'k.ts': 'const k = process.env.K\n' })
    expect(audit(d).code).toBe(0)
    const r = audit(d, '--history')
    expect(r.code).toBe(1)
    expect(r.out).toContain('k.ts:1')
  })
  test('--history finds a service_role JWT in a removed file', () => {
    const d = repo({ 'k.ts': `${jwt('service_role')}\n` })
    sh(d, ['git', 'rm', '-q', 'k.ts']); sh(d, ['git', 'commit', '-q', '-m', 'rm'])
    expect(audit(d, '--history').code).toBe(1)
  })
})
