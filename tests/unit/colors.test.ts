import { describe, expect, test } from 'bun:test'
import { contrast, effectiveText, NICK_CONTRAST, normalizeColor, readableOn, toRgb } from '../../plugin/hooks/lib/colors.ts'
import { nickColor } from '../../plugin/hooks/lib/format.ts'

describe('normalizeColor', () => {
  test('names, hex and default', () => {
    expect(normalizeColor('Navy')).toBeUndefined()
    expect(normalizeColor(' Blue ')).toBe('blue')
    expect(normalizeColor('grey')).toBe('gray')
    expect(normalizeColor('#2A1C15')).toBe('#2a1c15')
    expect(normalizeColor('#abc')).toBe('#aabbcc')
    expect(normalizeColor('default')).toBeNull()
    for (const bad of ['', '#12', '#12345g', 'rgb(1,2,3)', 'red;', '#1234567']) expect(normalizeColor(bad)).toBeUndefined()
  })
})

describe('contrast', () => {
  test('black on white is 21, a color on itself 1', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1)
    expect(contrast([42, 28, 21], [42, 28, 21])).toBe(1)
  })

  test('without a chosen text color, the pane picks a readable one', () => {
    expect(readableOn('#2a1c15')).toBe('#f2f2f2')
    expect(readableOn('#f6efe6')).toBe('#101010')
    expect(readableOn('yellow')).toBe('#101010')
    expect(effectiveText(null, null)).toBeNull()
    expect(effectiveText('#2a1c15', null)).toBe('#f2f2f2')
    expect(effectiveText('#2a1c15', 'red')).toBe('red')
  })
})

describe('nickColor on a background', () => {
  const nicks = ['lena', 'max_k', 'bob', 'zoe', 'a-very-long-name', 'x1', 'cbreakfan', 'nina', 'tom', 'q']
  const bgs = ['#000000', '#2a1c15', '#ffffff', '#f6efe6', 'yellow', 'blue', 'gray', '#336699']

  test('without a background it is the color the site and earlier versions draw', () => {
    for (const n of nicks) expect(nickColor(n, null)).toBe(nickColor(n))
  })

  test('every name reaches the target contrast on dark and light backgrounds', () => {
    for (const bg of ['#000000', '#2a1c15', '#ffffff', '#f6efe6', 'white', 'black'])
      for (const n of nicks) expect(contrast(toRgb(nickColor(n, bg))!, toRgb(bg)!)).toBeGreaterThanOrEqual(NICK_CONTRAST)
  })

  test('on mid-tone backgrounds the name moves as far as it can', () => {
    for (const bg of bgs)
      for (const n of nicks) {
        const c = contrast(toRgb(nickColor(n, bg))!, toRgb(bg)!)
        expect(c).toBeGreaterThanOrEqual(Math.min(NICK_CONTRAST, contrast(toRgb(nickColor(n))!, toRgb(bg)!)))
      }
  })

  test('a name keeps its color when it already reads, and stays stable', () => {
    expect(nickColor('lena', '#000000')).toBe(nickColor('lena', '#000000'))
    const already = nicks.filter((n) => contrast(toRgb(nickColor(n))!, [0, 0, 0]) >= NICK_CONTRAST)
    expect(already.length).toBeGreaterThan(0)
    for (const n of already) expect(nickColor(n, '#000000')).toBe(nickColor(n))
  })
})
