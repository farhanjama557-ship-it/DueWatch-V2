import { defineConfig, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The harness is launched from the repository root. Use cwd instead of
// import.meta.url because Vite bundles config files into a temporary folder
// before evaluation, which would make the latter point at `.vite-temp`.
const repoRoot = normalizePath(process.cwd())
const harnessDir = normalizePath(resolve(repoRoot, 'visual-harness'))
const dataMock = normalizePath(resolve(harnessDir, 'mockDataContext.js'))
const authMock = normalizePath(resolve(harnessDir, 'mockAuthContext.js'))

export default defineConfig({
  root: harnessDir,
  // Some imported UI modules construct the shared Supabase client at module
  // load even though the visual fixture never invokes their persistence
  // actions. Point that inert client at localhost so this harness can never
  // inherit or contact a hosted project.
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:54321'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('visual-harness-only'),
  },
  plugins: [
    react(),
    {
      name: 'pulse-visual-context-mocks',
      enforce: 'pre',
      resolveId(source) {
        if (/(^|\/)context\/DataContext(?:\.jsx)?$/.test(source)) return dataMock
        if (/(^|\/)context\/AuthContext(?:\.jsx)?$/.test(source)) return authMock
        return null
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
})
