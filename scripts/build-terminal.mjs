import { build } from 'esbuild'
import { chmod, mkdir } from 'node:fs/promises'
await mkdir('dist/terminal', { recursive: true })
await build({
  entryPoints: { cli: 'packages/terminal/cli.ts', worker: 'packages/runtime/worker-main.ts', checks: 'packages/runtime/checks-actor.ts' },
  outdir: 'dist/terminal', outExtension: { '.js': '.mjs' },
  platform: 'node', format: 'esm', target: 'node22', bundle: true, packages: 'external', sourcemap: true
})
await chmod('dist/terminal/cli.mjs', 0o755)
