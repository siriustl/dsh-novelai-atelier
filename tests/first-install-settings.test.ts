import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'
import { createApiHandler } from '../src/workbench/web.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('first-install HTTP credential persistence', () => {
  it('saves, replaces and reloads a synthetic token without returning plaintext credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-first-install-'))
    roots.push(root)
    const wb = new Workbench(root)
    const handler = createApiHandler({ workbench: wb, checkRequest: async () => true })
    const server = createServer((req, res) => { void handler(req, res, '/api/nai') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/nai/api`
    const put = (token: string) => fetch(`${url}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nai_token: token }) })
    try {
      expect((await (await fetch(`${url}/bootstrap`)).json()).settings.token_configured).toBe(false)
      const first = await put('  pst-first-install-fixture  ')
      expect(first.status).toBe(200)
      const response = await first.text()
      expect(JSON.parse(response)).toMatchObject({ token_configured: true, token_source: '工作台加密保存' })
      expect(response).not.toContain('pst-first-install-fixture')
      expect(wb.settings.naiToken()).toBe('pst-first-install-fixture')
      expect(new Workbench(root).settings.naiToken()).toBe('pst-first-install-fixture')
      for (const name of readdirSync(wb.settings.secretsDir).filter((name) => name.endsWith('.secret'))) {
        const stored = readFileSync(join(wb.settings.secretsDir, name), 'utf8')
        expect(stored).toMatch(/^NAI-SECRET-V1\n/)
        expect(stored).not.toContain('pst-first-install-fixture')
      }
      expect((await put('invalid-fixture')).status).toBe(400)
      expect(new Workbench(root).settings.naiToken()).toBe('pst-first-install-fixture')
      expect((await put('pst-replacement-fixture')).status).toBe(200)
      expect(new Workbench(root).settings.naiToken()).toBe('pst-replacement-fixture')
      const boot = await (await fetch(`${url}/bootstrap?compact=true`)).text()
      expect(JSON.parse(boot).settings.token_configured).toBe(true)
      expect(boot).not.toContain('pst-replacement-fixture')
      expect(wb.store.listJobs()).toHaveLength(0)
      expect(wb.store.listSchedules()).toHaveLength(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
