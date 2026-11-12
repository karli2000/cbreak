// Starts a real coffeebreakd process against the local stack and talks to it over its unix socket.
import type { Session } from "@supabase/supabase-js";
import type { Subprocess } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, ApiPath, ApiResult, HelperEvent } from "../../plugin/shared/protocol";
import { env } from "./_env";

const MAIN = join(import.meta.dir, "../../plugin/helper/main.ts");
const dirs: string[] = [];
const procs: Subprocess[] = [];

export type StartedHelper = {
  proc: Subprocess;
  dataDir: string;
  socket: string;
  events: HelperEvent[];
  waitFor<T extends HelperEvent["type"]>(
    type: T,
    pred?: (e: Extract<HelperEvent, { type: T }>) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<HelperEvent, { type: T }>>;
  call<P extends ApiPath>(path: P, body?: Api[P]["req"]): Promise<ApiResult<P>>;
  stop(): Promise<number | null>;
};

/** Writes a data dir (optionally pre-filled with auth.json) and returns its path. */
export function makeDataDir(session?: Session): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-helper-"));
  dirs.push(dir);
  if (session) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 1, session }), { mode: 0o600 });
  }
  return dir;
}

export async function startHelper(opts: { session?: Session; env?: Record<string, string> } = {}): Promise<StartedHelper> {
  const dataDir = makeDataDir(opts.session);
  const proc = Bun.spawn(["bun", MAIN], {
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      COFFEEBREAK_SUPABASE_URL: env().url,
      COFFEEBREAK_SUPABASE_ANON_KEY: env().anonKey,
      COFFEEBREAK_DATA_DIR: dataDir,
      COFFEEBREAK_NO_BROWSER: "1",
      ...opts.env,
    },
  });
  procs.push(proc);

  const events: HelperEvent[] = [];
  const waiters: (() => void)[] = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          try {
            events.push(JSON.parse(line))
          } catch {
            console.error('helper stdout (not JSON):', line)
          }
        };
        waiters.splice(0).forEach((w) => w());
      }
    }
  })();

  let seen = 0; // index of the next event waitFor may consume
  const waitFor: StartedHelper["waitFor"] = async (type, pred, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = seen; i < events.length; i++) {
        const e = events[i]!;
        if (e.type === type && (!pred || pred(e as never))) {
          seen = i + 1;
          return e as never;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for '${type}'; got ${JSON.stringify(events)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, Math.min(left, 100));
      });
    }
  };

  const hello = await waitFor("hello");
  const socket = hello.socket;

  return {
    proc,
    dataDir,
    socket,
    events,
    waitFor,
    async call(path, body) {
      const res = await fetch("http://localhost" + path, {
        unix: socket,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      } as RequestInit);
      return (await res.json()) as never;
    },
    async stop() {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited;
      return proc.exitCode;
    },
  };
}

/** Kills any helper still running and removes the temp data dirs. */
export function cleanupHelpers(): void {
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill("SIGKILL");
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
}
