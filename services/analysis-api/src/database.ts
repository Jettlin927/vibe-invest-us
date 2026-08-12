import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS positions (
      symbol TEXT PRIMARY KEY,
      quantity REAL NOT NULL CHECK (quantity > 0),
      average_cost REAL NOT NULL CHECK (average_cost >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portfolio_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cash REAL NOT NULL CHECK (cash >= 0),
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO portfolio_settings (id, cash, updated_at)
    VALUES (1, 0, CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS portfolio_equity_snapshots (
      market_day TEXT PRIMARY KEY,
      total_equity REAL NOT NULL,
      total_market_value REAL NOT NULL,
      cash REAL NOT NULL,
      holdings_count INTEGER NOT NULL,
      priced_count INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      after_close INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      snapshot_json TEXT,
      report_json TEXT,
      error TEXT,
      starred INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS atomic_facts (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS analysis_facts (
      analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      fact_id TEXT NOT NULL REFERENCES atomic_facts(id),
      PRIMARY KEY (analysis_id, fact_id)
    );
    CREATE TABLE IF NOT EXISTS analysis_trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
  `)
  return database
}
