import { nickColor } from '../../../plugin/hooks/lib/format.ts'
import type { Report } from '../api.ts'
import { COPY } from '../copy.ts'

/** Chat context of a report. All user content is plain text children. */
export function Snapshot({ snapshot, highlightId }: { snapshot: Report['snapshot']; highlightId: number | null }) {
  const lines = snapshot.context
  return (
    <div className="snapshot">
      {lines.length === 0 && snapshot.message === null && <p className="muted">No context.</p>}
      <ul className="snap-lines">
        {lines.map((l) => (
          <li key={l.id} className={l.id === highlightId ? 'snap-line snap-hl' : 'snap-line'} aria-current={l.id === highlightId ? 'true' : undefined}>
            <time className="muted" dateTime={l.created_at}>
              {new Date(l.created_at).toLocaleTimeString()}
            </time>{' '}
            <strong style={{ color: nickColor(l.nickname) }}>{l.nickname}</strong>
            {': '}
            <span className="snap-body">{l.body}</span>
            {l.deleted && <span className="muted"> (deleted)</span>}
          </li>
        ))}
      </ul>
      <p className="muted snap-note">{COPY.retention}</p>
    </div>
  )
}
