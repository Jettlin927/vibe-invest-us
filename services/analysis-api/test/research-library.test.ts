import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createPool, createResearchLibraryRepository } from '@vibe-invest/product-dao'
import { createResearchLibrary } from '../src/research-library.js'

test('历史检索覆盖研究和封存对话，分页且隐藏内部事件和凭据', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL!)
  const prefix = randomUUID()
  const ids = [`${prefix}-research`, `${prefix}-chat`]
  try {
    for (const [index, id] of ids.entries()) {
      await pool.query(`INSERT INTO analyses(id,kind,symbol,status,note,created_at,updated_at) VALUES($1,$2,$3,'completed',$4,now(),now())`, [id,index ? 'conversation':'research',index ? null:'NVDA',`公开${prefix}`])
      await pool.query(`INSERT INTO agent_sessions(id,analysis_id,is_primary,execution_id,status,created_at,updated_at) VALUES($1,$1,true,$1,'completed',now(),now())`, [id])
      for (const [sequence, payload] of [
        {type:'user_message',message:'NVDA 订单讨论 password=secret-value'},
        {type:'chat_completed',text:'已确认等待季度结果'},
        {type:'assistant_message',content:[{type:'text',text:'private-sentinel'}]},
        {type:'tool_result',result:{secret:'private-sentinel'}},
        {type:'text_delta',text:'streaming-sentinel'},
      ].entries()) await pool.query(`INSERT INTO agent_events(session_id,sequence,operation_id,payload_json,created_at) VALUES($1,$2,$3,$4,now())`,[id,sequence+1,String(sequence),JSON.stringify(payload)])
    }
    await pool.query(`INSERT INTO agent_executions(id,session_id,generation,status,terminal,created_at,updated_at) VALUES($1,$1,1,'completed',true,now(),now())`,[ids[0]])
    await pool.query(`INSERT INTO report_versions(id,analysis_id,session_id,execution_id,version,kind,payload_hash,report_json,created_at) VALUES($1,$2,$2,$2,1,'integrated',$3,$4,now())`,[prefix,ids[0],'a'.repeat(64),JSON.stringify({title:'已保存报告',marketState:'供需验证'+prefix,secret:'report-private-sentinel'})])
    await pool.query('INSERT INTO atomic_facts(id,payload_json,is_public) VALUES($1,$2,true)',[prefix,JSON.stringify({id:prefix,type:'quote',value:100,source:'official',sourceReference:'https://example.com/quote',observedAt:'2026-09-05',fetchedAt:'2026-09-05',secret:'fact-secret'})])
    await pool.query('INSERT INTO analysis_facts(analysis_id,fact_id) VALUES($1,$2)',[ids[0],prefix])
    const service = createResearchLibrary({repository:createResearchLibraryRepository(pool)})
    const original = await service.read(ids[0]!,0,1)
    assert.equal(original?.facts[0]?.value,100)
    assert.ok(!JSON.stringify(original).includes('fact-secret'))
    await service.recordSource(ids[1]!,original!)
    await service.recordSource(ids[1]!, (await service.read(ids[0]!,1,1))!)
    const reopened = createResearchLibrary({repository:createResearchLibraryRepository(pool)})
    const sources = await reopened.listSources(ids[1]!)
    assert.equal(sources[0]?.sourceRecordId,ids[0])
    assert.equal(sources[0]?.available,true)
    assert.deepEqual(sources[0]?.messageSequences,[1,2])
    assert.equal(sources[0]?.reportVersions[0]?.id,prefix)
    const first = await service.search({q:prefix,limit:1})
    assert.equal(first.total,2)
    assert.equal(first.items.length,1)
    const second = await service.search({q:prefix,limit:1,offset:1})
    assert.notEqual(first.items[0]?.id,second.items[0]?.id)
    assert.equal((await service.search({q:'private-sentinel'})).total,0)
    assert.equal((await service.search({q:'供需验证'+prefix})).total,1)
    assert.equal((await service.read(ids[0]!))?.reportVersions[0]?.version,1)
    assert.ok(!JSON.stringify(await service.read(ids[0]!)).includes('report-private-sentinel'))
    assert.equal((await service.search({q:'streaming-sentinel'})).total,0)
    assert.equal((await service.search({q:prefix,symbol:'nvda'})).total,2)
    const detail = await service.read(ids[1]!,0,1)
    assert.equal(detail?.total,2)
    assert.equal(detail?.messages.length,1)
    assert.equal(detail?.messages[0]?.role,'user')
    assert.ok(!JSON.stringify(detail).includes('secret-value'))
    assert.equal((await service.read(ids[1]!,1,1))?.messages[0]?.text,'已确认等待季度结果')
    assert.equal(await service.read('does-not-exist'),null)
    assert.equal((await service.search({q:'no-match-'+prefix})).total,0)
    await pool.query('DELETE FROM analyses WHERE id=$1',[ids[0]])
    const missing = (await reopened.listSources(ids[1]!))[0]
    assert.equal(missing?.available,false)
    assert.equal(missing?.href,null)
  } finally {
    await pool.query('DELETE FROM analyses WHERE id = ANY($1)',[ids])
    await pool.query('DELETE FROM atomic_facts WHERE id=$1',[prefix])
    await pool.end()
  }
})
