// Draws the cbreak pane from the Controller's PaneView. Pure: no `$`, no writes (a render hook may
// not write while drawing). The element constructors come from `$.ui.resolve(e)` in register.ts.
import type { BoxProps, ElementConstructor, InputProps, RenderElement, TextProps } from 'claude-code'
import type { Line, PaneView } from './lib/port.ts'

export type PaneElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Input: ElementConstructor<InputProps>
}

export type PaneHandlers = { input(v: string): void; submit(v: string): void }

/**
 * `fillRows`: the rows the tree should fill, so the input is always the pane's last row; the lines'
 * box takes the free rows and keeps its lines at its bottom, right above the input. 0 = as tall as
 * the lines (an inline pane, whose frame fits the tree anyway). A longer chat still scrolls, since
 * this is a minimum height.
 */
export function renderPane(view: PaneView, els: PaneElements, on: PaneHandlers, fillRows = 0): RenderElement {
  const { Box, Text, Input } = els
  const fill = fillRows > 0 ? { minHeight: fillRows } : {}
  const linesBox = (children: RenderElement[]) =>
    Box({ flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end', children })
  if (view.mode === 'setup') {
    return Box({
      flexDirection: 'column',
      ...fill,
      children: [
        linesBox(view.lines.map((l) => Text({ children: l }))),
        Input({ key: 'setup', placeholder: view.placeholder, value: view.draft, onInput: on.input, onSubmit: on.submit }),
      ],
    })
  }
  return Box({
    flexDirection: 'column',
    ...fill,
    children: [
      Text({ dimColor: true, children: view.header }),
      linesBox(view.lines.map((l) => lineElement(l, els))),
      // Always drawn: /leave and /help work outside a room too (room commands answer with a line).
      // autoFocus: whenever the pane takes the keyboard, the cursor lands in the field.
      // The grace countdown sits at its right, so it stays in view however long the chat is.
      Box({
        flexDirection: 'row',
        children: [
          Box({
            flexGrow: 1,
            children: [
              Input({
                key: 'say',
                placeholder: 'say something',
                submitLabel: 'send',
                value: view.draft,
                autoFocus: true,
                onInput: on.input,
                onSubmit: on.submit,
              }),
            ],
          }),
          ...(view.countdown ? [Text({ dimColor: true, children: ' ' + view.countdown })] : []),
        ],
      }),
    ],
  })
}

/**
 * A message is a row of two columns: the nickname (never shrinks or wraps) and the body, which
 * wraps inside its own column. So a long body's continuation rows start under the body, not at
 * the left edge, and cannot read like a system line (those are dim and start at column 0).
 */
function lineElement(l: Line, els: PaneElements): RenderElement {
  const { Box, Text } = els
  if (l.kind === 'system') return Text({ dimColor: true, children: l.text })
  const nick = Text({ color: l.color, bold: true, children: l.nickname })
  const body = l.segments.map((s) => (s.mention ? Text({ bold: true, inverse: true, children: s.text }) : s.text))
  const head = l.action ? Text({ italic: true, children: ['* ', nick, ' '] }) : Text({ children: [nick, ': '] })
  return Box({
    flexDirection: 'row',
    children: [
      Box({ flexShrink: 0, children: [head] }),
      Box({ flexGrow: 1, flexShrink: 1, children: [l.action ? Text({ italic: true, children: body }) : Text({ children: body })] }),
    ],
  })
}
