// The GitHub Actions workflows that deploy on a merge into main (docs/deploy.md "Automatic deploys").
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { SUPABASE_URL } from '../../plugin/shared/backend.ts'

const root = join(import.meta.dir, '../..')
const dir = join(root, '.github/workflows')
const FILES = ['deploy-database.yml', 'deploy-functions.yml', 'deploy-homepage.yml', 'deploy-mod-site.yml']

type Step = { uses?: string; run?: string; with?: Record<string, unknown> }
type Job = { needs?: string | string[]; steps: Step[]; environment?: string; env?: Record<string, string>; if?: string }
type Workflow = {
  on: { push: { branches: string[]; paths: string[] }; workflow_dispatch: unknown }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  env?: Record<string, string>
  jobs: Record<string, Job>
}

const text = (f: string) => readFileSync(join(dir, f), 'utf8')
const load = (f: string) => Bun.YAML.parse(text(f)) as Workflow
const runs = (w: Workflow, job: string) => w.jobs[job]!.steps.map((s) => s.run ?? '').join('\n')
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0]!

test('exactly the four deploy workflows exist', () => {
  expect(readdirSync(dir).sort()).toEqual(FILES)
})

describe.each(FILES)('%s', (f) => {
  const w = load(f)

  test('runs on a push to main and by hand, one run at a time, never cancelled', () => {
    expect(w.on.push.branches).toEqual(['main'])
    expect(w.on.push.paths.length).toBeGreaterThan(0)
    expect('workflow_dispatch' in w.on).toBe(true)
    expect(w['concurrency']['cancel-in-progress']).toBe(false)
  })

  test('reads the repo only', () => {
    expect(w.permissions).toEqual({ contents: 'read' })
  })

  test('every action is pinned to a commit', () => {
    const uses = Object.values(w.jobs).flatMap((j) => j.steps.flatMap((s) => (s.uses ? [s.uses] : [])))
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  test('never pushes the Supabase config (dashboard auth settings would be overwritten)', () => {
    for (const job of Object.keys(w.jobs)) expect(runs(w, job)).not.toMatch(/config\s+push/)
  })

  test('the deploy job runs in the production environment, only from main, and checks its secrets first', () => {
    const deploy = w.jobs['deploy']!
    expect(deploy.environment).toBe('production')
    expect(deploy.if).toBe("github.ref == 'refs/heads/main'")
    const first = deploy.steps.find((s) => s.run)!.run!
    expect(first).toContain('::error::')
  })
})

test('database: migrations are tested with pgTAP before they are pushed to the hosted project', () => {
  const w = load('deploy-database.yml')
  expect(w.on.push.paths).toEqual(['supabase/migrations/**'])
  expect(runs(w, 'test')).toContain('bun run db:test')
  expect(w.jobs['deploy']!.needs).toBe('test')
  expect(w.env!['PROJECT_REF']).toBe(PROJECT_REF)
  const push = runs(w, 'deploy')
  expect(push).toContain('bunx supabase db push --remote="$PROJECT_REF" --skip-vault --yes')
  expect(push).not.toContain('--include-seed')
  expect(push).not.toContain('--include-all')
})

test('functions: github-age is deployed to the hosted project', () => {
  const w = load('deploy-functions.yml')
  expect(w.on.push.paths).toEqual(['supabase/functions/**'])
  expect(w.env!['PROJECT_REF']).toBe(PROJECT_REF)
  expect(runs(w, 'deploy')).toContain('bunx supabase functions deploy github-age --use-api --remote="$PROJECT_REF" --yes')
})

/** Files outside `home` that the TypeScript under `dir` imports (relative imports), sorted. */
function importsOutside(dir: string, home: string): string[] {
  const outside = new Set<string>()
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name))
        for (const m of readFileSync(p, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
          const target = relative(root, resolve(dirname(p), m[1]!))
          if (!target.startsWith(home)) outside.add(target)
        }
    }
  }
  walk(join(root, dir))
  for (const p of outside) expect(existsSync(join(root, p))).toBe(true)
  return [...outside].sort()
}

test('moderator site: the paths cover every file outside site/ that the site imports', () => {
  const outside = importsOutside('site/src', 'site/')
  expect(outside.length).toBeGreaterThan(0)
  expect(load('deploy-mod-site.yml').on.push.paths).toEqual(['site/**', ...outside])
})

test('moderator site: tested, then deployed with the package script (one wrangler pin)', () => {
  const w = load('deploy-mod-site.yml')
  expect(runs(w, 'deploy')).toContain('bun test src/headers.test.ts')
  expect(runs(w, 'deploy')).toContain('bun run site:deploy')
})

test('homepage: the paths cover web/ and every file outside it that its function imports', () => {
  const outside = importsOutside('web/functions', 'web/')
  expect(outside).toEqual(['plugin/shared/backend.ts'])
  expect(load('deploy-homepage.yml').on.push.paths).toEqual(['web/**', ...outside])
})

test('homepage: tested, then deployed with the package script', () => {
  const w = load('deploy-homepage.yml')
  expect(runs(w, 'deploy')).toContain('bun test tests/unit/web.test.ts tests/unit/web-stats.test.ts')
  expect(runs(w, 'deploy')).toContain('bun run web:deploy')
})

test('the Cloudflare deploys pass the token and account id from secrets', () => {
  for (const f of ['deploy-homepage.yml', 'deploy-mod-site.yml']) {
    expect(load(f).jobs['deploy']!.env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    })
  }
})
