// Brand assets: the plugin icon PNG (Claude Code wants a square PNG of 512-2048 px), the site favicon
// and the README logo all come from the SVGs in brand/ (rebuild the PNGs with `bun run brand:png`).
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p))

function pngSize(buf: Buffer): { w: number; h: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG signature
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } // IHDR width, height
}

test('the plugin icon is a square 512 px PNG', () => {
  expect(pngSize(read('plugin/.claude-plugin/icon.png'))).toEqual({ w: 512, h: 512 })
})

test('the plugin icon is the rendered brand icon', async () => {
  const { renderIcon } = await import('../../scripts/render-brand.ts')
  expect(Buffer.compare(renderIcon(512), read('plugin/.claude-plugin/icon.png'))).toBe(0)
})

test('the site favicon is the brand icon and index.html links it', () => {
  expect(read('site/public/favicon.svg').toString()).toBe(read('brand/cbreak-icon.svg').toString())
  expect(read('site/index.html').toString()).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
})

test('the README starts with the logo, light and dark', () => {
  const head = read('README.md').toString().split('\n').slice(0, 8).join('\n')
  expect(head).toContain('brand/cbreak-logo.svg')
  expect(head).toContain('brand/cbreak-logo-on-dark.svg')
})

test('the style guide and its files exist', () => {
  for (const f of ['brand/README.md', 'brand/styleguide.html', 'brand/cbreak-mark.svg', 'brand/cbreak-mark-on-dark.svg', 'brand/cbreak-icon-light.svg', 'brand/cbreak-icon-1024.png']) {
    expect(existsSync(join(ROOT, f))).toBe(true)
  }
})
