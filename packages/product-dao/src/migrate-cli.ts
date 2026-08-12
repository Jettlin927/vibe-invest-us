import { migrate } from './index.js'

const databaseUrl = process.env.MIGRATION_DATABASE_URL
if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required')

await migrate(databaseUrl)
console.log('产品数据库迁移完成')
