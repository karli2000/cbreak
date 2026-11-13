// Where the helper's unix socket lives: a private directory of this user, never one somebody else
// planted. `$XDG_RUNTIME_DIR` (or `/run/user/<uid>`) is the user's own; the shared temp directory is
// not, so a directory there is used only if it is really ours (no symlink, our uid, mode 700) and a
// fresh private directory is made otherwise.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SocketDir = { dir: string; temporary: boolean }

/** The base directory for `cbreak-<uid>`: the user's runtime dir when there is one, else the temp dir. */
export function socketBase(env: NodeJS.ProcessEnv, uid: number): string {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR
  const run = `/run/user/${uid}`
  return existsSync(run) ? run : tmpdir()
}

/**
 * Creates (or accepts) `<base>/cbreak-<uid>`. An existing entry is accepted only when it is a plain
 * directory owned by this uid; a mode with group/other bits is tightened to 700. A symlink or a
 * directory of someone else (a planted one in /tmp) is left alone and a private temp directory is
 * used instead (`temporary`: remove it on exit).
 */
export function socketDir(base: string, uid: number): SocketDir {
  const dir = join(base, `cbreak-${uid}`)
  try {
    mkdirSync(dir, { mode: 0o700 }) // not recursive: an existing entry is checked below
    chmodSync(dir, 0o700) // mkdir's mode is masked by the umask
    return { dir, temporary: false }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return fallback()
  }
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) return fallback()
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
    return { dir, temporary: false }
  } catch {
    return fallback()
  }
}

function fallback(): SocketDir {
  return { dir: mkdtempSync(join(tmpdir(), 'cbreak-')), temporary: true } // mkdtemp makes it 700
}
