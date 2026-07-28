const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Carpeta persistente montada en Railway (Volume). En local (tu PC) no existe
// esa carpeta, así que usamos la de siempre como respaldo para seguir
// pudiendo desarrollar sin tocar nada.
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = path.join(DATA_DIR, 'licenses.db');
const OLD_DB_PATH = path.join(__dirname, 'licenses.db');

// Primera vez que arranca con el disco nuevo: si el disco persistente está
// vacío pero existe el archivo antiguo (el que estaba en el repo), lo copiamos
// una sola vez para no perder las licencias que ya existían.
if (DATA_DIR === '/data' && !fs.existsSync(DB_PATH) && fs.existsSync(OLD_DB_PATH)) {
  fs.copyFileSync(OLD_DB_PATH, DB_PATH);
  console.log('Migradas licencias existentes al disco persistente /data');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT UNIQUE NOT NULL,     -- hash bcrypt de la key (nunca texto plano)
  key_prefix TEXT NOT NULL,          -- primeros caracteres, solo para buscar/mostrar en admin
  status TEXT NOT NULL DEFAULT 'unused', -- unused | active | revoked
  device_id TEXT,                    -- dispositivo donde se activó (1 activación por key por defecto)
  customer_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  revoked_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT UNIQUE NOT NULL,
  manifest_json TEXT NOT NULL,       -- lista de archivos + checksums + tamaños
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS validation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT,
  device_id TEXT,
  ip TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stats del jugador, 1 fila por licencia. Se crea automáticamente al activar la key.
CREATE TABLE IF NOT EXISTS player_stats (
  license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
  username TEXT,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  xp_to_next_level INTEGER NOT NULL DEFAULT 100,
  coins INTEGER NOT NULL DEFAULT 0,
  equipped_skin TEXT,
  rank TEXT,
  elo INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  best_survival_seconds INTEGER NOT NULL DEFAULT 0,
  total_catches INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Novedades/changelog que se muestran en el launcher
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  date TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial de compras dentro del juego (con monedas, no dinero real).
-- Una fila por cada compra de skin confirmada por el servidor.
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  item_type TEXT NOT NULL,           -- de momento siempre 'skin'
  item_index INTEGER NOT NULL,       -- índice de la skin comprada
  price INTEGER NOT NULL,            -- monedas cobradas
  coins_after INTEGER NOT NULL,      -- monedas que le quedaron tras la compra
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pedidos de la tienda premium (monedas compradas con Solana). Una fila por
-- cada intento de compra; "reference" es la clave pública única que
-- identifica el pago en la blockchain (ver lib/shopWatcher.js).
CREATE TABLE IF NOT EXISTS premium_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  package_id TEXT NOT NULL,
  coins INTEGER NOT NULL,
  price_usd REAL NOT NULL,
  amount_sol TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | expired
  tx_signature TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_premium_orders_status ON premium_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_premium_orders_license ON premium_orders(license_id);

-- Clanes (guilds). Un jugador solo puede pertenecer a un clan a la vez (ver
-- guild_members, que tiene license_id como PRIMARY KEY). El líder es el
-- fundador del clan; puede expulsar miembros y, si se va, el clan pasa al
-- miembro más antiguo (ver routes/guild.js::leave).
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,                 -- 2-5 letras/números, se muestra junto al nombre del jugador
  description TEXT NOT NULL DEFAULT '',
  leader_license_id INTEGER NOT NULL REFERENCES licenses(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Un jugador solo puede estar en un clan a la vez: license_id como clave
-- primaria (no autoincremental) impone justo esa regla a nivel de esquema.
CREATE TABLE IF NOT EXISTS guild_members (
  license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chat de clan: mensajes simples, se leen por polling (GET con ?after=id)
-- desde el cliente mientras la pantalla de clan está abierta.
-- license_id se deja NULL para mensajes de sistema (alguien se une, se
-- expulsa a alguien, cambia el líder...), que no pertenecen a ningún
-- jugador concreto. Los mensajes normales de chat siempre llevan license_id.
CREATE TABLE IF NOT EXISTS guild_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  license_id INTEGER REFERENCES licenses(id),
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guilds_tag ON guilds(tag);
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_messages_guild ON guild_messages(guild_id, id);
`);

// Migración: la tabla player_stats se creó antes de que existiera la tienda.
// Si la columna no existe todavía (bases de datos antiguas), la añadimos sin
// borrar nada. Todo jugador nuevo parte con solo el skin 0 desbloqueado.
const playerStatsColumns = db.prepare("PRAGMA table_info(player_stats)").all().map((c) => c.name);
if (!playerStatsColumns.includes('unlocked_skins')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN unlocked_skins TEXT NOT NULL DEFAULT '[0]'");
  console.log('Migración aplicada: columna unlocked_skins añadida a player_stats');
}

// Migración: columnas del Pase de Batalla y el Torneo mensuales. Todo
// jugador existente arranca con progreso 0 (no hay nada que migrar, son
// funcionalidades nuevas). El "mes" se guarda vacío a propósito para que la
// primera vez que se toquen se detecte como "temporada nueva" y se
// inicialicen solas (ver ensureSeason en routes/player.js).
if (!playerStatsColumns.includes('battle_pass_xp')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN battle_pass_xp INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna battle_pass_xp añadida a player_stats');
}
if (!playerStatsColumns.includes('battle_pass_month')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN battle_pass_month TEXT NOT NULL DEFAULT ''");
  console.log('Migración aplicada: columna battle_pass_month añadida a player_stats');
}
if (!playerStatsColumns.includes('battle_pass_claimed')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN battle_pass_claimed TEXT NOT NULL DEFAULT '[]'");
  console.log('Migración aplicada: columna battle_pass_claimed añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_points')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_points INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna tournament_points añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_month')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_month TEXT NOT NULL DEFAULT ''");
  console.log('Migración aplicada: columna tournament_month añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_claimed')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_claimed TEXT NOT NULL DEFAULT '[]'");
  console.log('Migración aplicada: columna tournament_claimed añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_wins')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_wins INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna tournament_wins añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_matches')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_matches INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna tournament_matches añadida a player_stats');
}

module.exports = db;
