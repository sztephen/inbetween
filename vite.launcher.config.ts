import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// Bundles the stdio MCP launcher into one dependency-free CommonJS file so it can be
// run with plain Node or with the packaged app binary (ELECTRON_RUN_AS_NODE=1).
export default defineConfig({
  resolve: { alias: { '@core': resolve(__dirname, 'src/core') } },
  build: {
    outDir: 'out/launcher',
    emptyOutDir: true,
    ssr: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/launcher/inbetween-mcp.ts'),
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'cjs', entryFileNames: 'inbetween-mcp.cjs', inlineDynamicImports: true }
    }
  },
  ssr: { noExternal: true }
})
