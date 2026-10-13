import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import * as React from 'react'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const entry of Object.values(pkg.exports)) {
  for (const file of typeof entry === 'string' ? [entry] : Object.values(entry)) {
    assert.ok(existsSync(join(root, file)), `Missing package export: ${file}`)
  }
}
const host = await import('../lib/index.js')
assert.equal(host.name, pkg.name)
assert.equal(host.VERSION, pkg.version)
assert.equal(typeof host.apply, 'function')
const liveHost = await import('../lib/host-live.js')
assert.equal(liveHost.VERSION, pkg.version)
assert.equal(typeof liveHost.apply, 'function')
const agent = await import('../lib/agent.js')
assert.equal(agent.name, 'dsh-novelai-atelier-agent')
assert.equal(typeof agent.apply, 'function')
assert.deepEqual(agent.inject, ['tools', 'naiAtelier'])
let contribution
runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), { window: { __ModuleLoader__: { load: (value) => { contribution = value } } } })
assert.equal(contribution.id, pkg.name)
const client = contribution.factory((name) => {
  assert.equal(name, 'react')
  return React
})
assert.equal(typeof client.default.apply, 'function')
assert.ok(existsSync(join(root, 'assets/model-specs.json')))
assert.ok(existsSync(join(root, 'assets/guides/overview.md')))
console.log(`Package verified: ${pkg.name}@${pkg.version}, host/client entries, declarations and assets`)
