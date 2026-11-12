import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach } from 'bun:test'

GlobalRegistrator.register()

// Imported after registering so Testing Library sees the DOM globals.
const { cleanup } = await import('@testing-library/react')
afterEach(() => {
  cleanup()
  window.location.hash = ''
})
