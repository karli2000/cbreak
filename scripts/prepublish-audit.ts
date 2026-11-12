// Secret scanner behind scripts/prepublish-audit.sh. Scans tracked files, and with --history
// every added line in `git log --all -p`. Prints `file:line: reason` and exits 1 on a hit.
import { basename } from 'node:path'

const history = process.argv.includes('--history')

const git = (args: string[], maxBuffer = 1 << 30): string => {
  const r = Bun.spawnSync(['git', ...args], { maxBuffer })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString('latin1')
}

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.(eyJ[A-Za-z0-9_-]{5,})\.[A-Za-z0-9_-]{10,}/g
const SIMPLE: [RegExp, string][] = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key (sb_secret_)'],
  [/sbp_[0-9a-f]{40}/, 'Supabase access token (sbp_)'],
  [/gh[po]_[A-Za-z0-9]{20,}/, 'GitHub token (ghp_/gho_)'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token (github_pat_)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, 'private key'],
  [/SUPABASE_SERVICE_ROLE_KEY=\s*["']?[A-Za-z0-9_.-]{8,}/, 'SUPABASE_SERVICE_ROLE_KEY assignment with a value'],
]

function jwtRole(payload: string): string | null {
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof o?.role === 'string' ? o.role : null
  } catch { return null }
}

function scanLine(line: string): string[] {
  const hits: string[] = []
  for (const [re, why] of SIMPLE) if (re.test(line)) hits.push(why)
  for (const m of line.matchAll(JWT)) if (jwtRole(m[1]!) === 'service_role') hits.push('service_role JWT')
  return hits
}

const badPath = (p: string): string | null => {
  const b = basename(p)
  if (/^\.env(\..+)?$/.test(b) && !/\.(example|sample)$/.test(b)) return 'tracked .env file'
  if (/\.log$/.test(b)) return 'tracked log file'
  return null
}

const hits: string[] = []

// Working tree
const files = git(['ls-files', '-z']).split('\0').filter(Boolean)
for (const f of files) {
  const why = badPath(f)
  if (why) hits.push(`${f}:1: ${why}`)
  let text: string
  try { text = new TextDecoder('latin1').decode(await Bun.file(f).arrayBuffer()) } catch { continue }
  text.split('\n').forEach((line, i) => { for (const w of scanLine(line)) hits.push(`${f}:${i + 1}: ${w}`) })
}

// History: every added line, plus any .env / log path that was ever added.
if (history) {
  // --no-renames: a renamed file is scanned as an addition. -m: merge commits show their diff
  // against each parent, so content introduced only in a merge is scanned too.
  const out = git(['log', '--all', '-m', '-p', '--no-renames', '--no-color', '--no-ext-diff', '--format=commit %H', '-U0'])
  let commit = '', file = '', ln = 0, inHunk = false
  for (const line of out.split('\n')) {
    if (!inHunk && line.startsWith('commit ')) { commit = line.slice(7, 14); continue }
    if (line.startsWith('diff --git ')) {
      // File headers come from `diff --git`, never from content lines that happen to start with `++`.
      inHunk = false
      const i = line.lastIndexOf(' b/')
      file = i >= 0 ? line.slice(i + 3) : ''
      const why = file && badPath(file)
      if (why) hits.push(`${file}:1: ${why} (history, ${commit})`)
      continue
    }
    const h = /^@@ -\S+ \+(\d+)/.exec(line)
    if (h) { ln = Number(h[1]); inHunk = true; continue }
    if (inHunk && line.startsWith('+') && file) {
      for (const w of scanLine(line.slice(1))) hits.push(`${file}:${ln}: ${w} (history, ${commit})`)
      ln++
    }
  }
}

const uniq = [...new Set(hits)]
if (uniq.length) {
  console.error(uniq.join('\n'))
  console.error(`\nprepublish-audit: ${uniq.length} hit(s)`)
  process.exit(1)
}
console.log(`prepublish-audit: clean (${files.length} tracked files${history ? ', full history' : ''})`)
