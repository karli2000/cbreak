// Renders the PNGs made from brand/*.svg: the cbreak.dev link preview (web/og.png), the plugin icon (Claude Code wants a square PNG,
// 512-2048 px; SVG is not accepted) and a 1024 px copy in brand/. Run: bun run brand:png
// tests/unit/brand.test.ts fails when the committed plugin icon differs from a fresh render.
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
export const ICON_SVG = join(ROOT, 'brand/cbreak-icon.svg')

/** The brand icon as a square PNG of `size` px (no text, so no fonts are involved). */
export function renderIcon(size: number): Buffer {
  const svg = readFileSync(ICON_SVG, 'utf8')
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
}

/** The link-preview image for cbreak.dev (1200x630). It has text, so it uses the fonts of the machine
 *  that renders it (DejaVu on the owner's machine): checked for size only, not byte for byte. */
export function renderOg(): Buffer {
  const svg = readFileSync(join(ROOT, 'brand/og.svg'), 'utf8')
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng())
}

if (import.meta.main) {
  writeFileSync(join(ROOT, 'web/og.png'), renderOg())
  writeFileSync(join(ROOT, 'plugin/.claude-plugin/icon.png'), renderIcon(512))
  writeFileSync(join(ROOT, 'brand/cbreak-icon-1024.png'), renderIcon(1024))
  console.log('wrote web/og.png (1200x630), plugin/.claude-plugin/icon.png (512) and brand/cbreak-icon-1024.png (1024)')
}
