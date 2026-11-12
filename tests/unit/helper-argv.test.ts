import { describe, expect, test } from 'bun:test'
import { bunVersionOk, helperArgv, homeBunPath } from '../../plugin/hooks/lib/helper-argv.ts'

const ROOT = '/plugins/coffeebreak'

describe('helperArgv', () => {
  test('COFFEEBREAK_HELPER_SRC=1 runs the helper source with bun', () => {
    expect(helperArgv(ROOT, { pathBun: true, homeBun: null, fromSource: true })).toEqual(['bun', `${ROOT}/helper/main.ts`])
  })

  test('bun on PATH runs the committed bundle', () => {
    expect(helperArgv(ROOT, { pathBun: true, homeBun: '/home/x/.bun/bin/bun', fromSource: false })).toEqual([
      'bun',
      `${ROOT}/dist/coffeebreakd.js`,
    ])
  })

  test('finds bun in ~/.bun/bin when PATH has none', () => {
    expect(helperArgv(ROOT, { pathBun: false, homeBun: '/home/x/.bun/bin/bun', fromSource: false })).toEqual([
      '/home/x/.bun/bin/bun',
      `${ROOT}/dist/coffeebreakd.js`,
    ])
  })

  test('no bun anywhere gives null', () => {
    expect(helperArgv(ROOT, { pathBun: false, homeBun: null, fromSource: false })).toBeNull()
  })
})

describe('bunVersionOk', () => {
  test('accepts 1.2 and newer', () => {
    for (const v of ['1.2.0', '1.2.23\n', '1.4.4\n', '1.10.0', '2.0.0', ' 1.3.1 \n']) expect(bunVersionOk(v)).toBe(true)
  })

  test('refuses older or unreadable versions', () => {
    for (const v of ['1.1.38', '1.0.0\n', '0.9.9', '', 'bun', 'error: unknown']) expect(bunVersionOk(v)).toBe(false)
  })
})

describe('homeBunPath', () => {
  test('is ~/.bun/bin/bun under HOME', () => {
    expect(homeBunPath('/home/x')).toBe('/home/x/.bun/bin/bun')
    expect(homeBunPath('/home/x/')).toBe('/home/x/.bun/bin/bun')
  })

  test('is null without HOME', () => {
    expect(homeBunPath(undefined)).toBeNull()
    expect(homeBunPath('')).toBeNull()
  })
})
