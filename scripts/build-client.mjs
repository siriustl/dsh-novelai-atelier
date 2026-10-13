/** Client bundle builder: emits the DSH lazy-CJS module loader format. */
import { build } from 'esbuild'
import { readFileSync, mkdirSync, writeFileSync, readdirSync, renameSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const externals = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
for (const entry of ['index', 'agent']) {
  const declarations = readdirSync(join(root, 'lib')).filter((name) => new RegExp(`^${entry}-[A-Za-z0-9_-]+\\.d\\.ts$`, 'u').test(name))
  if (declarations.length > 1) throw new Error(`Expected one ${entry} declaration entry`)
  if (declarations.length === 1) renameSync(join(root, 'lib', declarations[0]), join(root, `lib/${entry}.d.ts`))
  else if (!existsSync(join(root, `lib/${entry}.d.ts`))) throw new Error(`Build the ${entry} bundle before the client`)
}
copyFileSync(join(root, 'lib/index.js'), join(root, 'lib/host-live.js'))
copyFileSync(join(root, 'lib/agent.js'), join(root, 'lib/agent-live.js'))
// NAI_DEBUG=1 → unminified bundle with sourcemaps for readable stack traces.
const debug = process.env['NAI_DEBUG'] === '1'

await build({
  entryPoints: [join(root, 'client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: join(root, 'lib/client.js'),
  external: externals,
  jsx: 'automatic',
  minify: !debug,
  banner: {
    js: `window.__ModuleLoader__.load({\n id: ${JSON.stringify(pkg.name)},\n factory: (require) => {\n  var module = { exports: {} };\n  var exports = module.exports;\n`,
  },
  footer: {
    js: '\n  return module.exports;\n }\n});\n//# sourceMappingURL=client.js.map',
  },
  sourcemap: true,
  logLevel: 'info',
})
mkdirSync(join(root, 'lib/types-client'), { recursive: true })
writeFileSync(join(root, 'lib/types-client/index.d.ts'), 'export {}\n')
console.log('client bundle built')
