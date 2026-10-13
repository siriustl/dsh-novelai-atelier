import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/workbench/store.ts'
const roots: string[]=[]
const store=()=>{const p=mkdtempSync(join(tmpdir(),'nai-schedule-edge-'));roots.push(p);return new Store(p)}
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true})})
const schedule=(at:string)=>({name:'local time',enabled:false,kind:'once',timezone:'Asia/Shanghai',at,operation:'generate',request:{prompt:'1boy',max_anlas:0}})
describe('schedule local timestamp boundaries',()=>{
 it('preserves local seconds in the exact UTC occurrence',()=>{
  const s=store(),p=s.saveSchedule(schedule('2026-10-02T01:30:45')),date=new Date(String(p.next_run))
  expect(date.toISOString()).toBe('2026-10-01T17:30:45.000Z')
 })
 it('retains the existing no-seconds interpretation and accepts a leap date',()=>{
  const s=store(),p=s.saveSchedule(schedule('2028-02-29T01:30'))
  expect(new Date(String(p.next_run)).toISOString()).toBe('2028-02-28T17:30:00.000Z')
 })
 it.each(['2026-02-30T01:00:00','2026-02-29T01:00:00','2026-13-01T01:00:00','2026-00-10T01:00:00','2026-10-02T25:00:00','2026-10-02T01:60:00','2026-10-02T01:30:60'])('rejects invalid local calendar input %s atomically',(at)=>{
  const s=store(),before=JSON.stringify(s.data)
  expect(()=>s.saveSchedule(schedule(at))).toThrow(/有效 ISO at/)
  expect(JSON.stringify(s.data)).toBe(before)
 })
})
describe('ordinary completed job cancellation',()=>{
 it('does not rewrite a completed unknown-spend result or expose reconciliation',()=>{
  const s=store(),job=s.recordDirectJob({operation:'generate',request:{max_anlas:5}},{id:'unknown'},null)
  expect(job).toMatchObject({status:'completed',actual_anlas:null})
  expect(s.cancelJob('unknown')).toMatchObject({status:'completed',actual_anlas:null})
  const before=JSON.stringify(s.data)
  expect(()=>s.finishJob('unknown',{actualAnlas:3})).toThrow(/已经结束/)
  expect(JSON.stringify(s.data)).toBe(before)
  expect(s.getPaused()).toBe(false)
 })
})
