/** Host-owned state shared by every NAI preset revision. */
import type { Context } from '@deepseek-ai/cordis'
import type { Workbench } from './workbench/app.ts'
import { NOVELAI_PROMPTING } from './workbench/skill.ts'

export type ToolExposure = 'global' | 'scoped'

export interface NaiAtelierRuntime {
  readonly workbench: Workbench
  readonly toolExposure: ToolExposure
  readonly onDemandTools?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    naiAtelier: NaiAtelierRuntime
  }
}

export function registerPromptingSkill(ctx: Context): void {
  ctx.inject(['skills'], (skillCtx) => skillCtx.effect(() => {
    const skills = skillCtx.get('skills') as { register?: (skill: typeof NOVELAI_PROMPTING) => () => void }
    return skills?.register?.({ ...NOVELAI_PROMPTING }) ?? (() => {})
  }, 'dsh-novelai-atelier prompting skill'))
}
