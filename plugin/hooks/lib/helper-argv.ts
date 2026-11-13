// Which command starts cbreakd. Pure (runs in the mod environment); register.ts finds the facts
// (`bun --version` on PATH, ~/.bun/bin/bun, CBREAK_HELPER_SRC) through the mods API.

/** The oldest Bun the helper supports. */
const MIN_BUN: readonly [number, number] = [1, 2]

/**
 * The helper's argv: the source with `CBREAK_HELPER_SRC=1` (dev), else the committed bundle run by
 * the `bun` on PATH, else by ~/.bun/bin/bun. null when there is no Bun.
 */
export function helperArgv(
  root: string,
  opts: { pathBun: boolean; homeBun: string | null; fromSource: boolean },
): string[] | null {
  if (opts.fromSource) return ['bun', `${root}/helper/main.ts`]
  const bundle = `${root}/dist/cbreakd.js`
  if (opts.pathBun) return ['bun', bundle]
  if (opts.homeBun) return [opts.homeBun, bundle]
  return null
}

/** True when `bun --version` printed a version of at least 1.2. */
export function bunVersionOk(text: string): boolean {
  const m = /^\s*(\d+)\.(\d+)(?:\.\d+)?/.exec(text)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > MIN_BUN[0] || (major === MIN_BUN[0] && minor >= MIN_BUN[1])
}

/** Where the Bun installer puts bun: `$HOME/.bun/bin/bun`. null without HOME. */
export function homeBunPath(home: string | undefined): string | null {
  if (!home) return null
  return `${home.replace(/\/+$/, '')}/.bun/bin/bun`
}
