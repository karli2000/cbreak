// The helper's data folder: $CBREAK_DATA_DIR, else <config>/cbreak (XDG_CONFIG_HOME or ~/.config).
// Coffee Break was renamed to cbreak in 0.3.0: an old <config>/coffeebreak folder (login, nothing
// else) is moved over once, so people stay signed in. An existing cbreak folder is never touched.
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export function dataDirFor(env: Record<string, string | undefined>, home: string): string {
  if (env.CBREAK_DATA_DIR) return env.CBREAK_DATA_DIR
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config')
  const dir = join(config, 'cbreak')
  const legacy = join(config, 'coffeebreak')
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir)
    } catch {} // another helper moved it first, or it is not movable: start signed out
  }
  return dir
}
