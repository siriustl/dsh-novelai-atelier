import { describe, expect, it, vi } from 'vitest'
import { createDshLlmBridge } from '../src/workbench/dshLlm.ts'
const payload = { messages: [{ role: 'user', content: 'test' }] }
const stream = () => vi.fn(async function* (_options: any) { yield { type: 'text-delta', text: 'OK' } })
describe('live AI default reasoning regression', () => {
 it('forwards the exact default selection effort into actual stream options', async () => {
  const calls=stream(), bridge=createDshLlmBridge({stream:calls},()=>({provider:'p',model:'gpt-test',reasoningEffort:'high'}))
  await bridge.complete(payload)
  expect(calls.mock.calls[0]![0]).toMatchObject({provider:'p',model:'gpt-test',reasoningEffort:'high'})
  expect(await bridge.describe()).toMatchObject({reasoningEffort:'high'})
 })
 it('does not inherit another models effort when overriding the route', async () => {
  const calls=stream(), bridge=createDshLlmBridge({stream:calls},()=>({provider:'p',model:'gpt-test',reasoningEffort:'xhigh'}))
  await bridge.complete(payload,undefined,{provider:'p',model:'other'})
  expect(calls.mock.calls[0]![0]).not.toHaveProperty('reasoningEffort')
 })
 it('respects an explicit override or payload effort over the default', async () => {
  const calls=stream(), bridge=createDshLlmBridge({stream:calls},()=>({provider:'p',model:'gpt-test',reasoningEffort:'high'}))
  await bridge.complete({...payload,reasoning_effort:'low'})
  await bridge.complete({...payload,reasoning_effort:'low'},undefined,{reasoningEffort:'medium'})
  expect(calls.mock.calls[0]![0].reasoningEffort).toBe('low')
  expect(calls.mock.calls[1]![0].reasoningEffort).toBe('medium')
 })
 it('leaves effort unspecified when the default does not select one', async () => {
  const calls=stream(), bridge=createDshLlmBridge({stream:calls},()=>({provider:'p',model:'m'}))
  await bridge.complete(payload)
  expect(calls.mock.calls[0]![0]).not.toHaveProperty('reasoningEffort')
 })
})
