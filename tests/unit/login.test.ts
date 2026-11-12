import { expect, test } from 'bun:test'
import { browserCommand } from '../../plugin/helper/login'

test('WSL opens the browser through powershell and doubles single quotes', () => {
  expect(browserCommand('https://x/?a=1', 'linux', true)).toEqual([
    'powershell.exe',
    ['-NoProfile', '-Command', "Start-Process 'https://x/?a=1'"],
  ])
  expect(browserCommand("https://x/?a='b", 'linux', true)[1][2]).toBe("Start-Process 'https://x/?a=''b'")
})

test('darwin uses open, linux uses xdg-open', () => {
  expect(browserCommand('https://x', 'darwin', false)).toEqual(['open', ['https://x']])
  expect(browserCommand('https://x', 'linux', false)).toEqual(['xdg-open', ['https://x']])
})
