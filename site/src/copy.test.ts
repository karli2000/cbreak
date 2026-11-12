import { expect, test } from 'bun:test'
import { errorText } from './copy.ts'

test('errorText maps known codes', () => {
  expect(errorText('forbidden')).toBe("You can't act on someone with the same or a higher role.")
  expect(errorText('not_authenticated')).toBe('Your session ended. Please sign in again.')
})

test('errorText falls back with the code', () => {
  expect(errorText('zzz')).toBe('Something went wrong (zzz).')
})
