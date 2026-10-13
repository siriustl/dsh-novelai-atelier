/** Workbench settings + authenticated local secret storage. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { defaultOutputDir } from '../core/service.ts'
import type { Store, Rec } from './store.ts'

export function checkUrl(value: string, optional = false): string {
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (!trimmed && optional) return ''
  let url: URL
  try { url = new URL(trimmed) } catch { throw new Error('地址需要是 HTTP(S) URL，不能含用户名、密码、查询或片段') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.search || url.hash)
    throw new Error('地址需要是 HTTP(S) URL，不能含用户名、密码、查询或片段')
  return trimmed
}

export class Settings {
  readonly secretsDir: string

  constructor(private store: Store, root: string, private fallbackToken: () => string = () => process.env['NOVELAI_TOKEN'] ?? '', private bridgeAvailable: () => boolean = () => false) {
    this.secretsDir = join(root, 'secrets')
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 })
    chmodSync(this.secretsDir, 0o700)
  }

  private secretKey(create = false): Buffer {
    const path = join(this.secretsDir, '.key')
    if (create && !existsSync(path)) {
      const encrypted = readdirSync(this.secretsDir).some((name) => name.endsWith('.secret')
        && readFileSync(join(this.secretsDir, name), 'utf8').startsWith('NAI-SECRET-V1\n'))
      if (encrypted) throw new Error('本地凭据密钥丢失；请恢复原密钥，不能生成替代密钥或仅重新保存令牌')
      try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const key = readFileSync(path)
    if (key.length !== 32) throw new Error('本地凭据密钥无效；请勿重置密钥，以免丢失已保存凭据')
    chmodSync(path, 0o600)
    return key
  }

  private writeSecret(reference: string, value: string): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.secretKey(true), iv)
    cipher.setAAD(Buffer.from(reference))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const envelope = 'NAI-SECRET-V1\n' + JSON.stringify({
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64'),
    })
    const path = join(this.secretsDir, reference + '.secret')
    const tmp = join(this.secretsDir, `secret-${randomBytes(16).toString('hex')}.tmp`)
    writeFileSync(tmp, envelope, { flag: 'wx', mode: 0o600 })
    try { renameSync(tmp, path) } catch (error) { try { unlinkSync(tmp) } catch { /* ignore */ } throw error }
  }

  /** Encrypt at rest; the local key shares the OS user boundary, not a password boundary. */
  seal(value: string, replaceExisting = false): string {
    const reference = createHash('sha256').update(value, 'utf8').digest('hex')
    if (!replaceExisting && existsSync(join(this.secretsDir, reference + '.secret'))) this.secret(reference)
    else this.writeSecret(reference, value)
    return reference
  }

  secret(reference: string | null | undefined): string {
    if (!reference) return ''
    if (reference.length !== 64 || /[^0-9a-f]/u.test(reference)) throw new Error('无效的凭据引用')
    const stored = readFileSync(join(this.secretsDir, reference + '.secret'), 'utf8')
    if (!stored.startsWith('NAI-SECRET-V1\n')) {
      if (createHash('sha256').update(stored, 'utf8').digest('hex') !== reference) throw new Error('本地凭据内容无效')
      this.writeSecret(reference, stored)
      return stored
    }
    try {
      const envelope = JSON.parse(stored.slice('NAI-SECRET-V1\n'.length)) as Record<string, unknown>
      if (!['iv', 'tag', 'data'].every((field) => typeof envelope[field] === 'string')) throw new Error('Invalid secret envelope')
      const iv = Buffer.from(envelope['iv'] as string, 'base64')
      const tag = Buffer.from(envelope['tag'] as string, 'base64')
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid secret envelope')
      const decipher = createDecipheriv('aes-256-gcm', this.secretKey(), iv)
      decipher.setAAD(Buffer.from(reference))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope['data'] as string, 'base64')), decipher.final()]).toString('utf8')
      if (createHash('sha256').update(plaintext, 'utf8').digest('hex') !== reference) throw new Error('Invalid secret content')
      return plaintext
    } catch {
      if (!existsSync(join(this.secretsDir, '.key'))) throw new Error('本地凭据解密失败：密钥丢失；请恢复原密钥，不能仅重新保存令牌')
      throw new Error('本地凭据解密失败；密钥损坏时请恢复原密钥，仅凭据文件损坏时可重新保存令牌')
    }
  }

  raw(): Rec {
    const values = this.store.getSettings()
    const defaults: Rec = {
      nai_base_url: 'https://image.novelai.net',
      proxy_url: process.env['HTTPS_PROXY'] ?? '',
      output_directory: defaultOutputDir(),
      creative_preferences: '',
      onboarding_complete: false,
      retry_delay_seconds: 3,
      retry_max_attempts: 3,
      ai: { dsh_provider: '', dsh_model: '', max_output_tokens: 4096 },
    }
    const merged = { ...defaults, ...values } as Rec
    merged['ai'] = { ...(defaults['ai'] as Rec), ...((values['ai'] ?? {}) as Rec) }
    return merged
  }

  naiToken(): string {
    const reference = this.raw()['nai_secret']
    return reference ? this.secret(reference as string) : this.fallbackToken()
  }

  public(): Rec {
    const raw = this.raw()
    let configured = false
    try { configured = Boolean(this.naiToken()) } catch { configured = false }
    const ai = raw['ai'] as Rec
    return {
      nai_base_url: raw['nai_base_url'], proxy_url: raw['proxy_url'],
      creative_preferences: raw['creative_preferences'], onboarding_complete: raw['onboarding_complete'],
      retry_delay_seconds: raw['retry_delay_seconds'], retry_max_attempts: raw['retry_max_attempts'],
      ai_profiles: this.profiles(),
      output_directory: raw['output_directory'], token_configured: configured,
      token_source: raw['nai_secret'] ? '工作台加密保存' : configured ? '插件配置' : '未配置',
      ai: {
        dsh_provider: ai['dsh_provider'] ?? '',
        dsh_model: ai['dsh_model'] ?? '',
        max_output_tokens: ai['max_output_tokens'] ?? 4096,
      },
    }
  }

  save(values: Rec): Rec {
    if (!(values instanceof Object) || Array.isArray(values)) throw new Error('设置必须是对象')
    const raw = this.raw()
    const allowed = new Set(['nai_base_url', 'proxy_url', 'output_directory', 'nai_token', 'ai', 'token_configured', 'token_source', 'creative_preferences', 'onboarding_complete', 'retry_delay_seconds', 'retry_max_attempts'])
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) throw new Error('包含未知设置字段')
    }
    for (const [key, minimum, maximum] of [['retry_delay_seconds', 0, 60], ['retry_max_attempts', 1, 10]] as const) {
      if (key in values) {
        const value = values[key]
        if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
          throw new Error(`${key === 'retry_delay_seconds' ? '重试间隔（秒）' : '最多尝试次数（含首次）'}需要 ${minimum}–${maximum} 的整数`)
        raw[key] = value
      }
    }
    if ('creative_preferences' in values) {
      if (typeof values['creative_preferences'] !== 'string' || values['creative_preferences'].length > 10000)
        throw new Error('个人创作偏好需要不超过 10000 字的文本')
      raw['creative_preferences'] = values['creative_preferences']
    }
    if ('onboarding_complete' in values) {
      if (typeof values['onboarding_complete'] !== 'boolean') throw new Error('引导状态无效')
      raw['onboarding_complete'] = values['onboarding_complete']
    }
    for (const key of ['nai_base_url', 'proxy_url'] as const) {
      if (key in values) raw[key] = checkUrl(String(values[key]), key === 'proxy_url')
    }
    if ('output_directory' in values) {
      const text = String(values['output_directory']).trim()
      if (!text || text.includes('\0')) throw new Error('请选择有效的图片保存目录')
      const path = text.replace(/^~(?=\/|\\|$)/u, process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.')
      if (!/^[A-Za-z]:[\\/]/u.test(path) && !path.startsWith('/')) throw new Error('图片保存目录需要绝对路径')
      mkdirSync(path, { recursive: true })
      raw['output_directory'] = path
    }
    const token = String(values['nai_token'] ?? '').trim()
    if (token) {
      if (!token.startsWith('pst-') || /\s/u.test(token)) throw new Error('NovelAI token 应以 pst- 开头且不含空白')
      raw['nai_secret'] = this.seal(token, true)
    }
    if ('ai' in values) {
      const updated = { ...(raw['ai'] as Rec) }
      this.applyAiUpdate(updated, values['ai'] as Rec)
      raw['ai'] = updated
    }
    this.store.saveSettings(raw)
    return this.public()
  }

  /** Validate and merge AI settings into a target object (without persisting). */
  private applyAiUpdate(updated: Rec, ai: Rec): void {
    const allowedAi = new Set(['dsh_provider', 'dsh_model', 'max_output_tokens'])
    if (!(ai instanceof Object) || Array.isArray(ai) || Object.keys(ai).some((k) => !allowedAi.has(k))) throw new Error('AI 设置字段无效')
    for (const key of ['dsh_provider', 'dsh_model'] as const) {
      if (key in ai) {
        const value = String(ai[key] ?? '').trim()
        if (value.length > 200) throw new Error(`${key === 'dsh_provider' ? 'Provider' : '模型'} ID 过长`)
        updated[key] = value
      }
    }
    if ('max_output_tokens' in ai) {
      if (typeof ai['max_output_tokens'] !== 'number' || !Number.isInteger(ai['max_output_tokens']) || ai['max_output_tokens'] < 256 || ai['max_output_tokens'] > 200000)
        throw new Error('max_output_tokens 需要 256–200000 的整数')
      updated['max_output_tokens'] = ai['max_output_tokens']
    }
  }

  freeze(): Rec {
    const raw = this.raw()
    return {
      nai_base_url: raw['nai_base_url'], proxy_url: raw['proxy_url'],
      output_directory: raw['output_directory'], nai_secret: this.seal(this.naiToken()),
      retry_delay_seconds: raw['retry_delay_seconds'], retry_max_attempts: raw['retry_max_attempts'],
    }
  }

  aiConfig(profileId = 'default'): Rec {
    const values = this.raw()
    const base = values['ai'] as Rec
    const profiles = (values['ai_profiles'] ?? {}) as Rec
    const ai = profileId === 'default' ? base : { ...base, ...(profiles[profileId] as Rec) }
    return {
      dsh_provider: ai['dsh_provider'] ?? '', dsh_model: ai['dsh_model'] ?? '',
      max_output_tokens: ai['max_output_tokens'] ?? 4096,
    }
  }

  aiKey(profileId = 'default'): string {
    const raw = this.raw()
    const base = raw['ai'] as Rec
    const profiles = (raw['ai_profiles'] ?? {}) as Rec
    const ai = profileId === 'default' ? base : (profiles[profileId] as Rec)
    return this.secret(ai?.['secret'] as string | undefined)
  }

  profiles(): Rec[] {
    const raw = this.raw()
    const base = raw['ai'] as Rec
    const profiles = (raw['ai_profiles'] ?? {}) as Rec
    const entries: Rec[] = [{ ...base, name: '默认连接' }]
    for (const [ident, ai] of Object.entries(profiles)) entries.push({ ...base, ...(ai as Rec), name: (ai as Rec)['name'] })
    return entries.map((ai, i) => {
      const id = i === 0 ? 'default' : Object.keys(profiles)[i - 1]!
      const provider = String(ai['dsh_provider'] ?? ''), model = String(ai['dsh_model'] ?? '')
      const mode = !provider && !model ? 'inherit_default' : provider && model ? 'override' : 'incomplete_override'
      const available = this.bridgeAvailable()
      return {
        id, name: String(ai['name'] ?? id),
        dsh_provider: provider, dsh_model: model,
        max_output_tokens: typeof ai['max_output_tokens'] === 'number' && Number.isFinite(ai['max_output_tokens']) ? ai['max_output_tokens'] : 4096,
        configuration_mode: mode, bridge_available: available,
        configured: available && mode !== 'incomplete_override',
        status: !available ? 'bridge_unavailable' : mode,
      }
    })
  }

  saveProfile(data: Rec, ident?: string | null): Rec {
    if (ident === 'default') {
      const { name: _n, id: _i, ...rest } = data
      void _n; void _i
      return this.save({ ai: rest })
    }
    const raw = this.raw()
    const profiles = (raw['ai_profiles'] ?? {}) as Rec
    const previous = ident ? profiles[ident] as Rec | undefined : undefined
    if (ident && !previous) throw new Error('连接不存在')
    const name = String(data['name'] ?? '').trim()
    if (name.length < 1 || name.length > 100) throw new Error('请填写连接名称')
    // Validate using a temporary in-memory copy, without changing the default
    // provider or leaking its key to a newly created profile.
    const seed = previous ?? Object.fromEntries(Object.entries(raw['ai'] as Rec).filter(([k]) => k !== 'secret'))
    const updated = structuredClone(seed) as Rec
    const aiInput = Object.fromEntries(Object.entries(data).filter(([k]) => !['id', 'name'].includes(k)))
    this.applyAiUpdate(updated, aiInput)
    const profile = { ...updated, name }
    const finalId = ident ?? randomHex()
    profiles[finalId] = profile
    raw['ai_profiles'] = profiles
    this.store.saveSettings(raw)
    return this.profiles().find((p) => p['id'] === finalId)!
  }

  deleteProfile(ident: string): Rec {
    if (ident === 'default') throw new Error('默认连接不能删除')
    if (store_listConversationsUsesProfile(this.store, ident)) throw new Error('此连接仍被会话使用，请先为会话选择其他连接')
    const raw = this.raw()
    const profiles = (raw['ai_profiles'] ?? {}) as Rec
    if (!(ident in profiles)) throw new Error('连接不存在')
    delete profiles[ident]
    raw['ai_profiles'] = profiles
    this.store.saveSettings(raw)
    return { deleted: true }
  }
}

function randomHex(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function store_listConversationsUsesProfile(store: Store, ident: string): boolean {
  return store.listConversations().some((c) => (c['profile_id'] ?? 'default') === ident)
}
