import type { PoolClient } from 'pg'

// 在业务事务提交前锁住会话：停止已完成则回滚，否则提交先于停止完成。
export async function assertActiveExecution(client: PoolClient, executionId?: string) {
  if (!executionId) return
  const current = await client.query(
    `SELECT session.id FROM agent_sessions session
     JOIN agent_executions execution ON execution.id = session.execution_id
     WHERE session.execution_id = $1 AND execution.id = $1 AND NOT execution.terminal
     FOR UPDATE OF session`, [executionId],
  )
  if (!current.rowCount) throw new Error('agent_execution_fenced')
}
