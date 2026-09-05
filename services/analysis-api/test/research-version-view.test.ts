import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createPool, createAnalysisRepository, createAgentEventRepository, createRuntimeSettingsRepository, createToolProjectionRepository, createPortfolioRepository, checkSchema } from '@vibe-invest/product-dao'
import { buildApp } from '../src/app.js'

test('指定历史报告显示冻结正文、事实和时间，未知版本不能回落最新报告', {skip: !process.env.TEST_DATABASE_URL}, async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL!)
  const id = randomUUID()
  const oldId = randomUUID()
  const latestId = randomUUID()
  const oldFact = {id:'old-fact',type:'quote',value:80,source:'official',sourceReference:'https://example.com/old',observedAt:'2026-08-01',fetchedAt:'2026-08-01'}
  const report = (title: string) => ({title,marketState:title,trend:'观察',keyJudgments:[{statement:title,supportingEvidence:['old-fact']}],limitations:[]})
  const app = buildApp({
    productDatabase:{checkSchema:()=>checkSchema(pool),close:async()=>{}},
    analysisRepository:createAnalysisRepository(pool),agentEventRepository:createAgentEventRepository(pool),
    runtimeSettingsRepository:createRuntimeSettingsRepository(pool),toolProjectionRepository:createToolProjectionRepository(pool),
    portfolioRepository:createPortfolioRepository(pool),modelConfigured:false,
    financialDataHealth:async()=>({service:'financial-data',status:'ok'}),
  })
  try {
    await pool.query(`INSERT INTO analyses(id,symbol,kind,status,created_at,updated_at,report_json,report_created_at) VALUES($1,'NVDA','research','completed',now(),now(),$2,now())`,[id,JSON.stringify(report('新版结论'))])
    await pool.query(`INSERT INTO agent_sessions(id,analysis_id,is_primary,execution_id,status,created_at,updated_at) VALUES($1,$1,true,$1,'completed',now(),now())`,[id])
    await pool.query(`INSERT INTO agent_executions(id,session_id,generation,status,terminal,created_at,updated_at) VALUES($1,$1,1,'completed',true,now(),now())`,[id])
    for (const [index,versionId] of [oldId,latestId].entries()) await pool.query(`INSERT INTO report_versions(id,analysis_id,session_id,execution_id,version,kind,payload_hash,report_json,snapshot_json,created_at) VALUES($1,$2,$2,$2,$3,'integrated',$4,$5,$6,$7)`,[versionId,id,index+1,String(index+1).repeat(64),JSON.stringify(report(index ? '新版结论':'旧版结论')),JSON.stringify({facts:[{...oldFact,value:index ? 100:80}]}),index ? '2026-09-05':'2026-08-01'])
    const response = await app.inject({method:'GET',url:`/api/research/${id}?reportVersionId=${oldId}`})
    assert.equal(response.statusCode,200,response.body)
    const value = response.json()
    assert.equal(value.report.title,'旧版结论')
    assert.equal(value.report.keyJudgments[0].judgment,'旧版结论')
    assert.equal(value.facts[0].value,80)
    assert.equal(value.reportCreatedAt,'2026-08-01T00:00:00.000Z')
    assert.equal(value.selectedReportVersion.id,oldId)
    assert.equal((await app.inject({method:'GET',url:`/api/research/${id}`})).json().report.title,'新版结论')
    assert.equal((await app.inject({method:'GET',url:`/api/research/${id}?reportVersionId=missing`})).statusCode,404)
    const missingSnapshotId = randomUUID()
    await pool.query(`INSERT INTO report_versions(id,analysis_id,session_id,execution_id,version,kind,payload_hash,report_json,created_at)
      VALUES($1,$2,$2,$2,3,'integrated',$3,$4,now())`, [missingSnapshotId,id,'3'.repeat(64),JSON.stringify(report('无冻结快照的历史报告'))])
    const missingSnapshot = (await app.inject({method:'GET',url:`/api/research/${id}?reportVersionId=${missingSnapshotId}`})).json()
    assert.deepEqual(missingSnapshot.facts,[])
    assert.match(missingSnapshot.report.limitations.join('；'),/缺少冻结事实/)
  } finally {
    await app.close()
    await pool.query('DELETE FROM analyses WHERE id=$1',[id])
    await pool.end()
  }
})
