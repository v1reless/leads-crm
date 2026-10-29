const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// DB_PATH можно задать в .env. По умолчанию база лежит в data/crm.sqlite.
const dbPath = path.resolve(__dirname, process.env.DB_PATH || 'data/crm.sqlite');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires
    ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    consent INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'in_progress', 'done', 'rejected')),
    source TEXT NOT NULL DEFAULT 'landing',
    admin_note TEXT NOT NULL DEFAULT '',
    telegram_sent INTEGER NOT NULL DEFAULT 0
      CHECK (telegram_sent IN (0, 1)),
    telegram_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_leads_status
    ON leads(status);

  CREATE INDEX IF NOT EXISTS idx_leads_created
    ON leads(created_at DESC);
`);

module.exports = { db, dbPath };
