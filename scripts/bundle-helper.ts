// Builds the committed helper bundle: `bun run helper:bundle` writes plugin/dist/coffeebreakd.js.
// Run it after every change to plugin/helper/ or plugin/shared/; tests/unit/helper-bundle.test.ts
// fails while the committed bundle differs from a fresh build.
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const ENTRY = 'plugin/helper/main.ts'
/** The bundle's path from the repository root. */
export const BUNDLE_PATH = 'plugin/dist/coffeebreakd.js'

/** The bundle's first line: which Bun built it. */
export function bundleHeader(): string {
  return `// coffeebreakd bundle, built with bun ${Bun.version}`
}

/** `bun build plugin/helper/main.ts --target=bun --minify` into `outfile`, with the header line in front. */
export async function bundleHelper(outfile: string): Promise<void> {
  const raw = `${outfile}.raw`
  try {
    const r = Bun.spawnSync([process.execPath, 'build', ENTRY, '--target=bun', '--minify', '--outfile', raw], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`bun build failed:\n${r.stderr.toString()}${r.stdout.toString()}`)
    const body = await Bun.file(raw).text()
    await Bun.write(outfile, `${bundleHeader()}\n${body}`)
  } finally {
    rmSync(raw, { force: true })
  }
}

if (import.meta.main) {
  await bundleHelper(resolve(REPO, BUNDLE_PATH))
  console.log(`wrote ${BUNDLE_PATH} (${bundleHeader()})`)
}
