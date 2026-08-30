const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'requirements.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    gitee_repo TEXT DEFAULT '',
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id INTEGER DEFAULT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    project_number TEXT NOT NULL DEFAULT '',
    gitee_repo TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    file_original_name TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (system_id) REFERENCES systems(id)
  );

  CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id INTEGER NOT NULL,
    status TEXT DEFAULT 'running',
    result_data TEXT DEFAULT '',
    logs TEXT DEFAULT '[]',
    agent_teams_data TEXT DEFAULT '',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (requirement_id) REFERENCES requirements(id)
  );
`);

// Add columns if upgrading from older version
try { db.exec(`ALTER TABLE requirements ADD COLUMN system_id INTEGER DEFAULT NULL`); } catch (e) {}
try { db.exec(`ALTER TABLE executions ADD COLUMN logs TEXT DEFAULT '[]'`); } catch (e) {}
try { db.exec(`ALTER TABLE executions ADD COLUMN agent_teams_data TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE executions ADD COLUMN engine_meta TEXT DEFAULT ''`); } catch (e) {}

// Seed some default systems if table is empty
const sysCount = db.prepare('SELECT COUNT(*) as c FROM systems').get().c;
if (sysCount === 0) {
  const insert = db.prepare('INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)');
  insert.run('认证服务', 'myteam/auth-service', '用户认证、权限管理相关');
  insert.run('数据看板', 'myteam/dashboard', '数据可视化与报表系统');
  insert.run('支付中心', 'myteam/payment', '支付流程、账单管理');
  insert.run('消息推送', 'myteam/notification', '推送通知、消息队列服务');
  console.log('[DB] Seeded 4 default systems');
}

// Helper to get current timestamp
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = { db, now };
