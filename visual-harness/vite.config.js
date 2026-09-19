import { defineConfig, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const repoRoot = normalizePath(process.cwd())
const harnessDir = normalizePath(resolve(repoRoot, 'visual-harness'))
const dataMock = normalizePath(resolve(harnessDir, 'mockDataContextPreview.js'))
const authMock = normalizePath(resolve(harnessDir, 'mockAuthContext.js'))

export default defineConfig({
  root: harnessDir,
  base: './',
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:54321'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('visual-harness-only'),
  },
  plugins: [
    react(),
    {
      name: 'duewatch-v1-preview-context-mocks',
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
