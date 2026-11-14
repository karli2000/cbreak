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

/** The chat input's key: register.ts hands the focus back to it after an emoji row was picked. */
export const SAY_KEY = 'say'
export const emojiKey = (name: string) => `emoji:${name}`


/**
 * `fillRows`: the rows the tree should fill, so the input is always the pane's last row; the lines'
 * box takes the free rows and keeps its lines at its bottom, right above the input. 0 = as tall as
 * the lines (an inline pane, whose frame fits the tree anyway). A longer chat still scrolls, since
 * this is a minimum height.
 */
export function renderPane(view: PaneView, els: PaneElements, on: PaneHandlers, fillRows = 0): RenderElement {
  const { Box, Text, Input } = els
  const fill = fillRows > 0 ? { minHeight: fillRows } : {}
  // the background is painted under the whole body by the pane's open (register.ts); text gets its color here
  const fg = view.colors.text ? { color: view.colors.text } : {}
  const linesBox = (children: RenderElement[]) =>
    Box({ flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end', children })
  if (view.mode === 'setup') {
    return Box({
      flexDirection: 'column',
      ...fill,
      children: [
        linesBox(view.lines.map((l) => Text({ ...fg, children: l }))),
        Input({ key: 'setup', placeholder: view.placeholder, value: view.draft, onInput: on.input, onSubmit: on.submit }),
      ],
    })
  }
  return Box({
    flexDirection: 'column',
    ...fill,
    children: [
      Text({ dimColor: true, ...fg, children: view.header }),
      linesBox(view.lines.map((l) => lineElement(l, els, fg))),
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
          ...(view.countdown ? [Text({ dimColor: true, ...fg, children: ' ' + view.countdown })] : []),
        ],
      }),
      ...emojiBox(view.suggestions, els, on, fg),
    ],
  })
}

/**
 * The emoji box (spike S4): one plain, dim row per match (`😄  :smile:`) right BELOW the input, best
 * first, as the prompt's own box. The focus ring follows the position in the draw order, not the key:
 * rows drawn above the input would shift it and take the ring off the input while typing (0.3.5's
 * bug), so they come after it. Down (or Tab) walks into them, Up back; Left/Right are the engine's.
 */
function emojiBox(rows: EmojiSuggestion[], els: PaneElements, on: PaneHandlers, fg: { color?: string }): RenderElement[] {
  if (rows.length === 0) return []
  const { Box, Button, Text } = els
  // the row's text is a Text child, so it takes the pane's text color (a Button has no color of its own)
  const buttons = rows.map((r) => {
    const label = `${r.emoji}  :${r.name}:`
    return Button({ key: emojiKey(r.name), label, plain: true, dimColor: true, onPress: () => on.pick(r.name), children: [Text({ ...fg, children: label })] })
  })
  return [Box({ flexDirection: 'column', children: buttons })]
}

/**
 * A message is a row of two columns: the nickname (never shrinks or wraps) and the body, which
 * wraps inside its own column. So a long body's continuation rows start under the body, not at
 * the left edge, and cannot read like a system line (those are dim and start at column 0).
 */
function lineElement(l: Line, els: PaneElements, fg: { color?: string }): RenderElement {
  const { Box, Text } = els
  if (l.kind === 'system') return Text({ dimColor: true, ...fg, children: l.text })
  const nick = Text({ color: l.color, bold: true, children: l.nickname })
  const body = l.segments.map((s) => (s.mention ? Text({ bold: true, inverse: true, children: s.text }) : s.text))
  const head = l.action ? Text({ italic: true, ...fg, children: ['* ', nick, ' '] }) : Text({ ...fg, children: [nick, ': '] })
  return Box({
    flexDirection: 'row',
    children: [
      Box({ flexShrink: 0, children: [head] }),
      Box({ flexGrow: 1, flexShrink: 1, children: [l.action ? Text({ italic: true, ...fg, children: body }) : Text({ ...fg, children: body })] }),
    ],
  })
}
