import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Pin the transform tsconfig. Otherwise Vite picks the nearest tsconfig of each file, and for
  // ../plugin/shared and ../plugin/hooks/lib that is plugin/tsconfig.json, which extends the
  // git-ignored generated types (missing on a fresh clone).
  tsconfig: 'tsconfig.json',
  // shared code lives outside site/ (../plugin/shared, ../plugin/hooks/lib/format.ts)
  server: { fs: { allow: ['..'] } },
})
