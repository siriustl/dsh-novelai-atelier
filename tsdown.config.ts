import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', agent: 'src/agent.ts' },
  format: 'esm',
  outDir: 'lib',
  dts: true,
  external: ['sharp', 'zod', 'undici', 'fflate', '@deepseek-ai/schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
  sourcemap: true,
  clean: true,
})
