/** Full NAI preset composition through the actual desktop Registry and Loader. No NAI or user store. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, symlink, lstat, realpath, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
assert.ok(process.versions.electron, 'Use the actual desktop Electron executable')
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
const project = dirname(dirname(fileURLToPath(import.meta.url)))
const anchor = process.env.NAI_SCOPE_HOST_MANIFEST || 'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/package.json'
const hostRequire = createRequire(anchor)
const hostImport = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const [{ Context }, scope, boot, { default: Loader, Group }, { default: Registry }, { default: Preset }, { default: ToolRuntime }, { default: SystemPrompt }, { default: Projections }, { default: Skills }, { default: Commands }, yaml, { entryListSchema }] = await Promise.all([
  hostImport('@deepseek-ai/cordis'), hostImport('@deepseek-ai/dsh-scope'), hostImport('@deepseek-ai/dsh-app-boot'),
  hostImport('@deepseek-ai/cordis-plugin-loader'), hostImport('@deepseek-ai/dsh-agent-preset-registry'), hostImport('@deepseek-ai/dsh-agent-preset'),
  hostImport('@deepseek-ai/dsh-tools'), hostImport('@deepseek-ai/dsh-system-prompt'), hostImport('@deepseek-ai/dsh-session-projection'), hostImport('@deepseek-ai/dsh-skill'), hostImport('@deepseek-ai/dsh-commands'), hostImport('js-yaml'), hostImport('@deepseek-ai/cordis-plugin-include'),
])
const patches = yaml.load(await readFile(join(project, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const presetRow = patches.flatMap(p => p.insert || []).find(p => p.id === 'preset-nai')
assert.ok(presetRow)
const baseResolution = await boot.createRuntimeResolution({ installAnchor: anchor, home: join(project, '.nai-verification/preset-composition') })
const syntheticProfile = join(project, '.nai-verification/preset-composition/profile')
await mkdir(syntheticProfile, { recursive: true })
await writeFile(join(syntheticProfile, 'package.json'), JSON.stringify({ name: 'nai-preset-verification', private: true, dependencies: { [pkg.name]: 'link:' + project } }))
await mkdir(join(syntheticProfile, 'node_modules'), { recursive: true })
const linkedPath = join(syntheticProfile, 'node_modules', pkg.name)
try { await lstat(linkedPath) } catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(project, linkedPath, process.platform === 'win32' ? 'junction' : 'dir') }
const resolution = {
  ...baseResolution,
  profileDir: syntheticProfile,
  localPackageNames: [pkg.name],
  entries: [...baseResolution.entries, { name: pkg.name, packageDir: project, version: pkg.version, declarer: join(syntheticProfile, 'package.json'), scope: 'profile' }],
  linkedRoots: [{ name: pkg.name, realPath: project }],
}
const report = { started_at: new Date().toISOString(), electron: process.versions.electron, node: process.versions.node, full_composition: true, user_store_used: false, nai_requests: 0, cases: [] }
async function harness(definition, expectedBroken) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(syntheticProfile, 'cordis.yml')).href
  const record = { name: expectedBroken ? 'missing-required-config' : 'complete-current-bundle', declared_plugins: definition.plugins.length }
  const called = []
  try {
    await ctx.plugin(boot.PluginPackages, { resolution })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(project, 'cordis.patch.yml')).href })
    const originalImport = ctx.loader.internal.import.bind(ctx.loader.internal)
    ctx.loader.internal.import = async (...args) => {
      try { return await originalImport(...args) }
      catch (error) { (record.import_errors ??= []).push({ name: args[0], base: args[1], error: error.stack }); throw error }
    }
    ctx.loader.builtins.group = Group
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Ordinary host persona', personaSuffix: '' })
    ctx.systemPrompt.variable('cwd', () => project)
    await ctx.plugin(Projections)
    await ctx.plugin(Skills, {})
    await ctx.plugin(Commands)
    await ctx.plugin(ToolRuntime, {})
    // Host backends are isolated adapters; every declared preset row is a real runtime module.
    for (const name of ['fs', 'subprocess', 'agents', 'userQuestions', 'llm', 'sessions', 'tokenMeter']) ctx.provide(name, new Proxy({}, { get(_value, key) {
      if (key === 'then' || key === 'sandboxMode' || key === 'defaultSandboxMode' || key === 'sandboxDefaultMode') return undefined
      return (...args) => { called.push(`${name}.${String(key)}`); throw new Error(`Unexpected host backend invocation ${name}.${String(key)}`) }
    } }))
    const draft = { id: 'probe-draft', revision: 0, operation: 'generate', request: { prompt: '' } }
    ctx.provide('naiAtelier', { toolExposure: 'scoped', workbench: { store: { getDraft: () => draft } } })
    await ctx.plugin(Registry, { default: 'ordinary' })
    const ordinaryDispose = await ctx.agentPresets.register({ id: 'ordinary', name: 'Ordinary', plugins: [] })
    const presetFiber = await ctx.plugin(Preset, definition)
    await presetFiber.await()
    const roster = await ctx.agentPresets.list()
    const found = roster.find(row => row.id === 'nai')
    assert.ok(found)
    record.roster = found
    record.inventory = (await ctx.agentPresets.compositionInventory()).find(row => row.id === 'nai')
    assert.deepEqual(record.import_errors ?? [], [], 'All declared modules must import through the real Loader')
    if (expectedBroken) {
      assert.match(found.broken || '', /^tool-fs-search /)
      assert.match(found.broken || '', /sampleOverCapGlobResults.*missing required value/)
      assert.equal(ctx.tools.schemas().filter(t => t.name.startsWith('nai_')).length, 0)
    } else {
      assert.equal(found.broken, undefined)
      assert.ok(record.inventory.rows.every(row => row.enabled !== true || row.fiberState === 2), 'Every enabled composition row must be ACTIVE')
      const lease = await ctx.agentPresets.acquireScope('nai')
      const ordinary = await ctx.agentPresets.acquireScope('ordinary')
      try {
        const names = ctx.tools.schemas(lease.key).map(t => t.name)
        assert.equal(names.filter(n => n.startsWith('nai_')).length, 15)
        for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'skill', 'ask_user_question', 'present']) assert.ok(names.includes(name), name)
        assert.equal(new Set(names).size, names.length)
        assert.equal(ctx.tools.schemas(ordinary.key).filter(t => t.name.startsWith('nai_')).length, 0)
        assert.equal(ctx.tools.schemas().filter(t => t.name.startsWith('nai_')).length, 0)
        const naiSkills = await ctx.skills.list({ scope: lease.key })
        const ordinarySkills = await ctx.skills.list({ scope: ordinary.key })
        assert.ok(naiSkills.some(skill => skill.name === 'novelai-prompting'))
        assert.ok(!ordinarySkills.some(skill => skill.name === 'novelai-prompting'))
        record.skill_isolated = true
        const bound = scope.createScope(ctx, {})
        const child = scope.createScope(ctx, {})
        try {
          await ctx.agentPresets.mount(bound.ctx, 'nai')
          assert.equal(ctx.agentPresets.composeFrom(child.ctx, bound.ctx), 'nai')
          assert.equal(ctx.tools.schemas(scope.scopeOf(child.ctx)).filter(t => t.name.startsWith('nai_')).length, 15)
          const result = await ctx.tools.get('nai_draft', scope.scopeOf(bound.ctx)).execute({ action: 'read' }, { signal: new AbortController().signal })
          assert.equal(result.id, draft.id)
          const compaction = ctx.agentPresets.serviceFor({ ctx: bound.ctx }, 'compaction')
          const pruner = ctx.agentPresets.serviceFor({ ctx: bound.ctx }, 'toolResultPruner')
          assert.ok(compaction && pruner)
          assert.equal(ctx.get('compaction'), undefined)
          assert.equal(ctx.get('toolResultPruner'), undefined)
          const assembly = await ctx.systemPrompt.assemble({ scope: scope.scopeOf(bound.ctx) })
          assert.ok(assembly.sections.some(section => section.text.includes('NovelAI image creation assistant')))
          record.active_tool_count = names.length
          record.nai_tool_count = 15
          record.ordinary_nai_tools = 0
          record.descendant_nai_tools = 15
          record.shared_draft_read = true
          record.services_isolated = true
          record.prompt_composed = true
        } finally { await child.dispose(); await bound.dispose() }
      } finally { await lease[Symbol.asyncDispose](); await ordinary[Symbol.asyncDispose]() }
    }
    await presetFiber.dispose()
    assert.ok(!(await ctx.agentPresets.list()).some(row => row.id === 'nai'))
    assert.equal(ctx.tools.schemas().filter(t => t.name.startsWith('nai_')).length, 0)
    await ordinaryDispose()
    assert.deepEqual(called, [], 'Composition must not invoke model, filesystem or NAI backends')
    record.passed = true
    record.host_backend_calls = called
  } catch (error) { record.error = error.stack; record.host_backend_calls = called; throw error }
  finally { report.cases.push(record); await ctx.fiber.dispose() }
}
try {
  const broken = structuredClone(presetRow.config)
  const search = broken.plugins.find(row => row.id === 'tool-fs-search')
  delete search.config
  await harness(broken, true)
  await harness(structuredClone(presetRow.config), false)
  report.passed = true
} catch (error) { report.passed = false; console.error(error); process.exitCode = 1 }
finally {
  const path = process.env.NAI_PRESET_REPORT || join(project, '.nai-verification/preset-composition-report.json')
  await mkdir(dirname(path), { recursive: true })
  const linkInfo = await lstat(linkedPath)
  assert.ok(linkInfo.isSymbolicLink(), 'Refuse to remove a non-link fixture path')
  assert.equal((await realpath(linkedPath)).toLowerCase(), project.toLowerCase(), 'Fixture junction must target this project')
  // Remove the verified junction itself, never its resolved target.
  await rm(linkedPath, { recursive: true, force: true })
  report.fixture_junction_removed = true
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, report: path, cases: report.cases.map(record => ({ name: record.name, passed: record.passed, broken: record.roster?.broken, active_rows: record.inventory?.rows?.filter(row => row.fiberState === 2).length, nai_tool_count: record.nai_tool_count, host_backend_calls: record.host_backend_calls, error: record.error })) }, null, 2))
}
