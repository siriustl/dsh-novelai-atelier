import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Settings } from '../src/workbench/settings.ts'
import { Store } from '../src/workbench/store.ts'

let root: string
let settings: Settings
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nai-secret-'))
  settings = new Settings(new Store(root), root, () => 'pst-plugin-fallback')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('credential storage', () => {
  it('encrypts tokens at rest and decrypts after restart', () => {
    const token = 'pst-private-token'
    const reference = settings.seal(token)
    const path = join(settings.secretsDir, reference + '.secret')
    const stored = readFileSync(path, 'utf8')
    expect(stored).toMatch(/^NAI-SECRET-V1\n/)
    expect(stored).not.toContain(token)
    expect(settings.secret(reference)).toBe(token)
    expect(new Settings(new Store(root), root).secret(reference)).toBe(token)
    expect(readFileSync(join(settings.secretsDir, '.key')).length).toBe(32)
    if (process.platform !== 'win32') {
      expect(statSync(settings.secretsDir).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(settings.secretsDir, '.key')).mode & 0o777).toBe(0o600)
    }
  })

  it('reads and atomically migrates legacy plaintext credentials', () => {
    const token = 'pst-legacy-token'
    const reference = createHash('sha256').update(token).digest('hex')
    const path = join(settings.secretsDir, reference + '.secret')
    writeFileSync(path, token)
    expect(settings.secret(reference)).toBe(token)
    expect(readFileSync(path, 'utf8')).not.toContain(token)
    expect(readFileSync(path, 'utf8')).toMatch(/^NAI-SECRET-V1\n/)
    expect(settings.secret(reference)).toBe(token)
  })

  it('rejects ciphertext tampering and swapping between secret references', () => {
    const first = settings.seal('pst-first-token')
    const second = settings.seal('pst-second-token')
    const firstPath = join(settings.secretsDir, first + '.secret')
    const secondPath = join(settings.secretsDir, second + '.secret')
    writeFileSync(firstPath, readFileSync(secondPath))
    expect(() => settings.secret(first)).toThrow(/解密失败/)
    const envelope = JSON.parse(readFileSync(secondPath, 'utf8').split('\n')[1]!)
    envelope.tag = Buffer.alloc(16).toString('base64')
    writeFileSync(secondPath, 'NAI-SECRET-V1\n' + JSON.stringify(envelope))
    expect(() => settings.secret(second)).toThrow(/解密失败/)
  })

  it('does not reset missing or invalid keys when reading ciphertext', () => {
    const reference = settings.seal('pst-existing-token')
    const keyPath = join(settings.secretsDir, '.key')
    rmSync(keyPath)
    expect(() => settings.secret(reference)).toThrow(/解密失败/)
    writeFileSync(keyPath, new Uint8Array([1, 2]))
    expect(() => settings.secret(reference)).toThrow(/解密失败/)
    expect(readFileSync(keyPath)).toEqual(Buffer.from([1, 2]))
  })

  it('does not expose legacy endpoint credentials or arbitrary profile properties', () => {
    const store = new Store(root)
    store.saveSettings({ ai: { api_key: 'legacy-default-key', headers: { Authorization: 'Bearer private' }, dsh_provider: 'selected', dsh_model: 'model' }, ai_profiles: { legacy: { name: 'Legacy', apiKey: 'legacy-profile-key', password: 'private-password', base_url: 'https://private:password@example.invalid', max_output_tokens: 1024 } } })
    const publicValue = new Settings(store, root).public()
    const encoded = JSON.stringify(publicValue)
    for (const secret of ['legacy-default-key', 'legacy-profile-key', 'private-password', 'Bearer private', 'private:password']) expect(encoded).not.toContain(secret)
    expect((publicValue['ai_profiles'] as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'default', dsh_provider: 'selected', dsh_model: 'model' })
    expect((publicValue['ai_profiles'] as Array<Record<string, unknown>>)[1]).toMatchObject({ id: 'legacy', name: 'Legacy', max_output_tokens: 1024 })
  })

  it('repairs a damaged token envelope on explicit save without changing other credentials', () => {
    const token = 'pst-isolated-repair-token'
    settings.save({ nai_token: token })
    const reference = createHash('sha256').update(token).digest('hex')
    const path = join(settings.secretsDir, reference + '.secret')
    const other = settings.seal('pst-isolated-other-token')
    const otherPath = join(settings.secretsDir, other + '.secret')
    const otherBytes = readFileSync(otherPath)
    const keyBytes = readFileSync(join(settings.secretsDir, '.key'))
    writeFileSync(path, 'NAI-SECRET-V1\n{"iv":"invalid"}')
    expect(() => settings.seal(token)).toThrow(/解密失败/)
    expect(() => settings.save({ nai_token: token })).not.toThrow()
    expect(settings.naiToken()).toBe(token)
    expect(settings.secret(other)).toBe('pst-isolated-other-token')
    expect(readFileSync(otherPath)).toEqual(otherBytes)
    expect(readFileSync(join(settings.secretsDir, '.key'))).toEqual(keyBytes)
  })

  it.each(['pst-isolated-existing-token', 'pst-isolated-new-token'])('never regenerates a missing key on explicit save of %s', (token) => {
    const existing = settings.seal('pst-isolated-existing-token')
    const path = join(settings.secretsDir, existing + '.secret')
    const bytes = readFileSync(path)
    const keyPath = join(settings.secretsDir, '.key')
    rmSync(keyPath)
    expect(() => settings.save({ nai_token: token })).toThrow()
    expect(() => readFileSync(keyPath)).toThrow()
    expect(readFileSync(path)).toEqual(bytes)
  })

  it('rejects array or null AI updates without mutating settings', () => {
    const before = settings.raw()
    expect(() => settings.save({ ai: [] })).toThrow(/AI 设置/)
    expect(() => settings.save({ ai: null })).toThrow(/AI 设置/)
    expect(settings.raw()).toEqual(before)
  })

  it('preserves workbench-token precedence over the plugin fallback', () => {
    expect(settings.naiToken()).toBe('pst-plugin-fallback')
    settings.save({ nai_token: 'pst-stored-token' })
    expect(settings.naiToken()).toBe('pst-stored-token')
    expect(JSON.stringify(settings.public())).not.toContain('pst-stored-token')
    expect(JSON.stringify(new Store(root).getSettings())).not.toContain('pst-stored-token')
  })
})
