// Draws the coffee pane from the Controller's PaneView. Pure: no `$`, no writes (a render hook may
// not write while drawing). The element constructors come from `$.ui.resolve(e)` in register.ts.
import type { BoxProps, ElementConstructor, InputProps, RenderElement, TextProps } from 'claude-code'
import type { Line, PaneView } from './lib/port.ts'

export type PaneElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Input: ElementConstructor<InputProps>
}

export type PaneHandlers = { input(v: string): void; submit(v: string): void }

export function renderPane(view: PaneView, els: PaneElements, on: PaneHandlers): RenderElement {
  const { Box, Text, Input } = els
  if (view.mode === 'setup') {
    return Box({
      flexDirection: 'column',
      children: [
        ...view.lines.map((l) => Text({ children: l })),
        Input({ key: 'setup', placeholder: view.placeholder, value: view.draft, onInput: on.input, onSubmit: on.submit }),
      ],
    })
  }
  return Box({
    flexDirection: 'column',
    children: [
      Text({ dimColor: true, children: view.header }),
      ...view.lines.map((l) => lineElement(l, Text)),
      // Always drawn: /leave and /help work outside a room too (room commands answer with a line).
      Input({
        key: 'say',
        placeholder: 'say something',
        submitLabel: 'send',
        value: view.draft,
        onInput: on.input,
        onSubmit: on.submit,
      }),
    ],
  })
}

function lineElement(l: Line, Text: PaneElements['Text']): RenderElement {
  if (l.kind === 'system') return Text({ dimColor: true, children: l.text })
  const nick = Text({ color: l.color, bold: true, children: l.nickname })
  const body = l.segments.map((s) => (s.mention ? Text({ bold: true, inverse: true, children: s.text }) : s.text))
  if (l.action) return Text({ italic: true, children: ['* ', nick, ' ', ...body] })
  return Text({ children: [nick, ': ', ...body] })
}
