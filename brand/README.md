# cbreak style guide

The cbreak mark is one shape with four readings. A thick lowercase **c** is drawn as an open circle, and three warm dots rise out of its opening.

| The c stands for… | How the mark shows it |
|---|---|
| **coffee** | The open c is the rim of a cup seen from above; the dots rise like steam. |
| **chat** | Read across, the dots are a "someone is typing…" indicator. |
| **code** | The wordmark is set in a monospace with a cursor, because cbreak lives in a terminal. |
| **claude** | An unfinished circle is a loading spinner: Claude is working, so you are on a break. |

Open [`styleguide.html`](styleguide.html) in a browser to see all of it on one page.

## Files

| File | Use |
|---|---|
| `cbreak-icon.svg` | App icon, dark (espresso square). Source of the plugin icon and the site favicon. |
| `cbreak-icon-light.svg` | App icon, light (cream square), for dark backgrounds. |
| `cbreak-icon-1024.png` | The dark app icon at 1024 px, e.g. for a GitHub social preview or avatar. |
| `cbreak-mark.svg` | The mark alone, no background, for light backgrounds. |
| `cbreak-mark-on-dark.svg` | The mark alone for dark backgrounds. |
| `cbreak-logo.svg` | Mark + wordmark, for light backgrounds (top of the README). |
| `cbreak-logo-on-dark.svg` | Mark + wordmark for dark backgrounds (GitHub dark mode). |
| `styleguide.html` | This guide as a page: lockups, the four readings, icon sizes, colors. |

Copies elsewhere in the repo:
- **Plugin icon:** `plugin/.claude-plugin/icon.png`, 512 px. Claude Code wants a square PNG of 512 to 2048 px and does not accept SVG. Rebuild it with `bun run brand:png` (`scripts/render-brand.ts`, using `@resvg/resvg-js`). `tests/unit/brand.test.ts` fails if it no longer matches a fresh render of `cbreak-icon.svg`.
- **Site favicon:** `site/public/favicon.svg` is a copy of `cbreak-icon.svg` (the test checks they match), linked from `site/index.html`.

## Colors

| Name | Hex | Use |
|---|---|---|
| Espresso | `#2A1C15` | The c and text on light; the dark background |
| Cream | `#F6EFE6` | The light background; the c and text on dark |
| Caramel | `#B8612A` | Accent on light (the dots, the c of the wordmark, the cursor) |
| Crema | `#E59A5C` | Accent on dark |
| Roast | `#6B5446` | Secondary text on cream (6:1 on cream) |
| Steam | `#C9B7A6` | Secondary text on espresso (8:1 on espresso) |

Caramel on cream is about 3.9:1: fine for the mark, the large wordmark and bold text of 19 px and up, never for small body text.

## Type

- **Wordmark and code-ish lines:** JetBrains Mono, ExtraBold 800 for `cbreak`, Medium 500 for the cursor and secondary lines. Letter spacing −0.04 em on the wordmark. The `c` is in the accent color, followed by a cursor in the accent (`_`, or a block when animated).
- **Running text:** Inter (or the platform's system sans).
- The SVG logos name JetBrains Mono first and fall back to the system monospace (where GitHub shows them, web fonts are not loaded).

## Geometry

- **The c:** an arc of radius 34 around (50, 50) in a 120 × 100 box, from −40° to +40° the long way round (an 80° opening facing right), stroke 16, round caps: `M76.05 28.14 A34 34 0 1 0 76.05 71.86`.
- **The dots:** radius 6 at (72, 56), (88, 46) and (104, 36): rising to the right, out of the opening.
- **App icon:** a 128 × 128 square, corner radius 28. The mark is scaled to 86 % and centered, with stroke 15 and dots of radius 6.5.
- **Clear space:** at least the height of the c's stroke on every side.
- **Smallest size:** 16 px for the app icon (the dots merge into one warm spot and it still reads); 24 px for the mark alone; 120 px wide for the logo with wordmark.

## Don'ts

- Don't use Anthropic's or Claude's logo, starburst or brand marks with it. The "claude" reading comes from the idea only, and nothing may suggest cbreak is an official Anthropic product.
- Don't close the c or turn the dots into a different number: three dots, one open c.
- Don't put the caramel accent on espresso or the crema accent on cream; each accent belongs to its background.
- Don't stretch, outline or add shadows or gradients.
