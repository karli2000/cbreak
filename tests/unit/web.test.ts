// cbreak.dev (web/): a static page for Cloudflare Pages. It loads nothing from other sites, its CSP
// allows no inline code, its brand files are copies of brand/, and its install steps match the README.
import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const pages = ['web/index.html', 'web/404.html']

test('the brand files are copies of brand/', () => {
  expect(read('web/favicon.svg')).toBe(read('brand/cbreak-icon.svg'))
  expect(read('web/cbreak-mark.svg')).toBe(read('brand/cbreak-mark.svg'))
  expect(read('web/cbreak-mark-on-dark.svg')).toBe(read('brand/cbreak-mark-on-dark.svg'))
})

test('the install commands are the README ones', () => {
  const readme = read('README.md')
  const html = read('web/index.html')
  for (const cmd of ['claude plugin marketplace add karli2000/cbreak', 'claude plugin install cbreak@cbreak', 'curl -fsSL https://bun.sh/install | bash']) {
    expect(readme).toContain(cmd)
    expect(html).toContain(cmd)
  }
  expect(html).toContain('href="https://github.com/karli2000/cbreak"')
})

test('nothing is loaded from another site, nothing inline', () => {
  for (const p of pages) {
    const html = read(p)
    // src/href of resources (not plain links): only same-site paths
    for (const m of html.matchAll(/<(script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
      expect(m[2]!.startsWith('/') && !m[2]!.startsWith('//')).toBe(true)
    }
    expect(html).not.toMatch(/<style\b/)
    expect(html).not.toMatch(/\sstyle="/)
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/) // no inline script
    expect(html).not.toMatch(/\son[a-z]+="/) // no inline handlers
  }
})

test('every local file a page names exists', () => {
  for (const p of pages) {
    for (const m of read(p).matchAll(/\b(?:src|href)="(\/[^"#]*)"/g)) {
      const path = m[1] === '/' ? '/index.html' : m[1]!
      expect(existsSync(join(ROOT, 'web', path))).toBe(true)
    }
  }
})

test('the headers set a strict CSP', () => {
  const h = read('web/_headers')
  expect(h).toContain("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'")
  expect(h).toContain("frame-ancestors 'none'")
  expect(h).toContain('X-Content-Type-Options: nosniff')
})

test('the link preview image is 1200x630, and web/ holds only the site', () => {
  const buf = readFileSync(join(ROOT, 'web/og.png'))
  expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1200, 630])
  expect(readdirSync(join(ROOT, 'web')).sort()).toEqual(
    ['404.html', '_headers', 'cbreak-mark-on-dark.svg', 'cbreak-mark.svg', 'favicon.svg', 'index.html', 'main.js', 'og.png', 'styles.css'],
  )
})
