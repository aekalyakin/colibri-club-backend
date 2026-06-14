const pool = require('./db');
 
var SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (",
  "  id SERIAL PRIMARY KEY,",
  "  telegram_id BIGINT UNIQUE,",
  "  full_name VARCHAR(255),",
  "  email VARCHAR(255),",
  "  phone VARCHAR(20),",
  "  created_at TIMESTAMP DEFAULT NOW()",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS memberships (",
  "  id SERIAL PRIMARY KEY,",
  "  user_id INTEGER REFERENCES users(id),",
  "  status VARCHAR(20) DEFAULT 'active',",
  "  started_at TIMESTAMP DEFAULT NOW(),",
  "  expires_at TIMESTAMP NOT NULL,",
  "  created_at TIMESTAMP DEFAULT NOW()",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS payments (",
  "  id SERIAL PRIMARY KEY,",
  "  user_id INTEGER REFERENCES users(id),",
  "  prodamus_order_id VARCHAR(255) UNIQUE,",
  "  amount NUMERIC(10,2),",
  "  status VARCHAR(20) DEFAULT 'pending',",
  "  membership_id INTEGER REFERENCES memberships(id),",
  "  paid_at TIMESTAMP,",
  "  created_at TIMESTAMP DEFAULT NOW()",
  ");",
  "",
  "CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);",
  "CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_memberships_expires_at ON memberships(expires_at);",
  "CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);",
  "",
  "CREATE TABLE IF NOT EXISTS admins (",
  "  id SERIAL PRIMARY KEY,",
  "  telegram_id BIGINT UNIQUE NOT NULL,",
  "  full_name VARCHAR(255),",
  "  phone VARCHAR(20),",
  "  role VARCHAR(20) NOT NULL DEFAULT 'admin',", // owner | manager | admin
  "  added_by BIGINT,",
  "  created_at TIMESTAMP DEFAULT NOW()",
  ");",
  "",
  "CREATE INDEX IF NOT EXISTS idx_admins_telegram_id ON admins(telegram_id);"
].join("\n");
 
async function runMigrations() {
  try {
    await pool.query(SCHEMA);
    console.log("Migration done: tables are ready");
 
    // Создаём начального владельца из переменной окружения, если его ещё нет
    var ownerIds = (process.env.OWNER_TELEGRAM_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    for (var i = 0; i < ownerIds.length; i++) {
      await pool.query(
        "INSERT INTO admins (telegram_id, role) VALUES ($1, 'owner') " +
        "ON CONFLICT (telegram_id) DO UPDATE SET role = 'owner'",
        [ownerIds[i]]
      );
    }
    if (ownerIds.length > 0) {
      console.log("Owner seed done: " + ownerIds.join(', '));
    }
  } catch (err) {
    console.error("Migration error:", err.message);
  }
}
 
module.exports = { runMigrations: runMigrations };
 
