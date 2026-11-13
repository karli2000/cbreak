// cbreak.dev: the numbers from /api/stats (same origin, refreshed every minute while the tab shows),
// the break illustration played once, and the copy buttons. No storage, no other site.
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---- copy buttons ----
  for (const btn of document.querySelectorAll('button[data-copy]')) {
    btn.addEventListener('click', async () => {
      const code = document.getElementById(btn.dataset.copy)
      if (!code) return
      try {
        await navigator.clipboard.writeText(code.textContent.trim())
        btn.textContent = 'Copied'
      } catch {
        btn.textContent = 'Select it'
      }
      setTimeout(() => (btn.textContent = 'Copy'), 2000)
    })
  }

  // ---- the numbers ----
  const pulse = document.querySelector('[data-stats]')
  if (pulse) {
    const fmt = new Intl.NumberFormat('en')
    const load = async () => {
      try {
        const res = await fetch('/api/stats', { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const s = await res.json()
        for (const el of pulse.querySelectorAll('[data-stat]')) {
          const v = s[el.dataset.stat]
          if (typeof v === 'number') el.textContent = fmt.format(v)
        }
        pulse.hidden = false
      } catch {
        // offline or unavailable: the section stays as it was (hidden until the first answer)
      }
    }
    load()
    setInterval(() => {
      if (!document.hidden) load()
    }, 60_000)
  }

  // ---- the break, played once ----
  const term = document.querySelector('[data-demo]')
  if (!term || reduce) return // the markup already shows the finished state
  const lines = [...term.querySelectorAll('.chat li:not(.done)')]
  const doneLine = term.querySelector('.chat li.done')
  const spin = term.querySelector('.spin')
  const clock = term.querySelector('[data-clock]')
  const countdown = term.querySelector('[data-countdown]')
  const here = term.querySelector('[data-here]')
  term.classList.add('play')

  const frames = ['◐', '◓', '◑', '◒']
  let f = 0
  let secs = 21
  const spinner = setInterval(() => {
    spin.textContent = frames[(f = (f + 1) % frames.length)]
  }, 160)
  const ticker = setInterval(() => {
    secs++
    clock.textContent = `(${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s)`
  }, 1000)

  const at = (ms, fn) => setTimeout(fn, ms)
  here.textContent = '3'
  at(1200, () => term.classList.add('s-pane'))
  lines.forEach((li, i) => at(2000 + i * 1300, () => {
    li.classList.add('on')
    if (i === 0) here.textContent = '4'
  }))
  at(2000 + lines.length * 1300 + 800, () => {
    clearInterval(spinner)
    clearInterval(ticker)
    spin.textContent = '◉'
    doneLine.classList.add('on')
    term.classList.add('s-done')
    let left = 15
    const down = setInterval(() => {
      left--
      countdown.textContent = `closes in ${left} s`
      if (left <= 1) clearInterval(down)
    }, 1000)
  })
})()
