// Draws the cbreak pane from the Controller's PaneView. Pure: no `$`, no writes (a render hook may
// not write while drawing). The element constructors come from `$.ui.resolve(e)` in register.ts.
import type { BoxProps, ButtonProps, ElementConstructor, InputProps, RenderElement, TextProps } from 'claude-code'
import type { EmojiSuggestion } from './lib/emoji.ts'
import type { Line, PaneView } from './lib/port.ts'

export type PaneElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Input: ElementConstructor<InputProps>
  Button: ElementConstructor<ButtonProps>
}

/** `pick`: an emoji row was pressed (Enter on it, or a click), by its name. */
export type PaneHandlers = { input(v: string): void; submit(v: string): void; pick(name: string): void }

/** The address of an emoji row: `ui.focus` names it, so register.ts can tell the rows from the input. */
export const SAY_KEY = 'say'
export const emojiKey = (name: string) => `emoji:${name}`

/**
 * Whether a focus move is the person's Tab out of the chat input: from `say` to one of the engine's
 * stops (the pane's close mark; `element` absent). Up lands on our own last row instead.
 */
export function isTabFromInput(focused: string | undefined, e: { element?: string; origin: { kind: string } }): boolean {
  return focused === SAY_KEY && e.element === undefined && e.origin.kind === 'person'
}

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
      ...emojiBox(view.suggestions, els, on),
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
                key: SAY_KEY,
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
 * The emoji box (spike S4): one plain, dim row per match (`😄  :smile:`) right above the input, best
 * match at the bottom, so Up from the input reaches it first (the focus ring follows the draw order;
 * Left/Right belong to the engine, so the rows stack). Tab in the input takes the best one (register.ts).
 */
function emojiBox(rows: EmojiSuggestion[], els: PaneElements, on: PaneHandlers): RenderElement[] {
  if (rows.length === 0) return []
  const { Box, Button } = els
  const buttons = rows
    .map((r) => Button({ key: emojiKey(r.name), label: `${r.emoji}  :${r.name}:`, plain: true, dimColor: true, onPress: () => on.pick(r.name) }))
    .reverse()
  return [Box({ flexDirection: 'column', children: buttons })]
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
