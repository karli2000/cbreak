import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // shared code lives outside site/ (../plugin/shared, ../plugin/hooks/lib/format.ts)
  server: { fs: { allow: ['..'] } },
})
