/** Preset-owned tools and skill; never creates a Workbench or worker. */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { registerTools } from './tools.ts'
import { registerPromptingSkill } from './runtime.ts'

export const name = 'dsh-novelai-atelier-agent'
export const inject = ['tools', 'naiAtelier']

export function apply(ctx: Context): void {
  if (scopeOf(ctx) === undefined) throw new Error('dsh-novelai-atelier/agent must be mounted inside an agent preset')
  const runtime = ctx.naiAtelier
  if (runtime.toolExposure === 'global') return
  registerTools(ctx, runtime.workbench)
  registerPromptingSkill(ctx)
}
