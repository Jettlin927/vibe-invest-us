import { executeMigration, planMigration, verifyMigration } from './sqlite-migration.js'

const [command] = process.argv.slice(2)
const source = process.env.LEGACY_SQLITE_PATH
if (!source) throw new Error('LEGACY_SQLITE_PATH is required')

let result: unknown
if (command === 'plan') {
  result = await planMigration(source)
} else if (command === 'execute') {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  result = await executeMigration({
    source,
    databaseUrl: process.env.DATABASE_URL,
    apiHealthUrl: process.env.MIGRATION_API_HEALTH_URL ?? 'http://127.0.0.1:3000/api/health',
  })
} else if (command === 'verify') {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!process.env.MIGRATION_API_BASE_URL) throw new Error('MIGRATION_API_BASE_URL is required')
  result = await verifyMigration({
    source,
    databaseUrl: process.env.DATABASE_URL,
    apiBaseUrl: process.env.MIGRATION_API_BASE_URL,
  })
} else {
  throw new Error('usage: migrate:sqlite -- plan|execute|verify')
}

console.log(JSON.stringify(result, null, 2))
