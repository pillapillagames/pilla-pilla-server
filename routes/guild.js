const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');

const router = express.Router();

// Límites de la funcionalidad. El tope de miembros escala con el nivel del
// clan (ver maxMembersForLevel) pero sigue acotado para que no crezca sin
// control; CHAT_HISTORY_LIMIT evita mandar historiales gigantes cada vez que
// se abre la pantalla.
const MAX_MEMBERS_BASE = 50;
const MAX_MEMBERS_CAP = 80;
const MAX_MEMBERS_PER_LEVEL = 2; // cada nivel de clan añade 2 huecos más, hasta el tope
const NAME_REGEX = /^.{3,24}$/; // longitud libre de contenido, 3-24 caracteres
const TAG_REGEX = /^[a-zA-Z0-9]{2,5}$/; // 2-5 letras/números, sin espacios ni símbolos
const CHAT_HISTORY_LIMIT = 50;
const MESSAGE_MAX_LENGTH = 200;
const MAX_DONATION = 100000; // límite defensivo por donación individual

// Cuánta xp hace falta para pasar del nivel `level` al siguiente. Sube según
// el propio nivel para que cada nivel cueste un poco más que el anterior.
function xpToNextLevel(level) {
  return level * 500;
}

// Cuántos miembros caben en un clan de nivel `level` (con tope superior).
function maxMembersForLevel(level) {
  return Math.min(MAX_MEMBERS_BASE + (level - 1) * MAX_MEMBERS_PER_LEVEL, MAX_MEMBERS_CAP);
}

function getUsername(licenseId) {
  const row = db.prepare('SELECT username FROM player_stats WHERE license_id = ?').get(licenseId);
  return (row && row.username) || `Jugador${licenseId}`;
}

function getMembership(licenseId) {
  return db.prepare('SELECT * FROM guild_members WHERE license_id = ?').get(licenseId);
}

function getGuildById(guildId) {
  return db.prepare('SELECT * FROM guilds WHERE id = ?').get(guildId);
}

function memberCount(guildId) {
  return db.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?').get(guildId).n;
}

function guildPayload(guild) {
  return {
    id: guild.id,
    name: guild.name,
    tag: guild.tag,
    description: guild.description,
    leaderLicenseId: guild.leader_license_id,
    memberCount: memberCount(guild.id),
    maxMembers: maxMembersForLevel(guild.level),
    level: guild.level,
    xp: guild.xp,
    xpToNextLevel: xpToNextLevel(guild.level),
    bankCoins: guild.bank_coins,
    createdAt: guild.created_at,
  };
}

function membersPayload(guildId) {
  const rows = db
    .prepare(
      `SELECT gm.license_id AS licenseId, gm.joined_at AS joinedAt,
              COALESCE(ps.username, 'Jugador' || gm.license_id) AS username,
              COALESCE(ps.level, 1) AS level
       FROM guild_members gm
       LEFT JOIN player_stats ps ON ps.license_id = gm.license_id
       WHERE gm.guild_id = ?
       ORDER BY gm.joined_at ASC`
    )
    .all(guildId);
  return rows;
}

// GET /api/guild/mine  (requiere token)
// Devuelve el clan del jugador actual (con sus miembros) o { ok: true, guild: null } si no está en ninguno.
router.get('/mine', requireToken, (req, res) => {
  const membership = getMembership(req.license.id);
  if (!membership) {
    return res.json({ ok: true, guild: null });
  }
  const guild = getGuildById(membership.guild_id);
  if (!guild) {
    // Estado inconsistente defensivo (el clan se borró pero la membresía
    // quedó huérfana): limpiamos y devolvemos "sin clan" en vez de romper.
    db.prepare('DELETE FROM guild_members WHERE license_id = ?').run(req.license.id);
    return res.json({ ok: true, guild: null });
  }
  res.json({ ok: true, guild: guildPayload(guild), members: membersPayload(guild.id) });
});

// GET /api/guild/search?q=texto  (requiere token)
// Busca clanes por nombre o tag (insensible a mayúsculas), hasta 20 resultados.
router.get('/search', requireToken, (req, res) => {
  const q = (req.query.q || '').toString().trim();
  let rows;
  if (q === '') {
    rows = db.prepare('SELECT * FROM guilds ORDER BY created_at DESC LIMIT 20').all();
  } else {
    const like = `%${q}%`;
    rows = db
      .prepare('SELECT * FROM guilds WHERE name LIKE ? COLLATE NOCASE OR tag LIKE ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 20')
      .all(like, like);
  }
  res.json({ ok: true, guilds: rows.map(guildPayload) });
});

// POST /api/guild/create  body: { name, tag, description }  (requiere token)
router.post('/create', requireToken, (req, res) => {
  const name = (req.body?.name || '').trim();
  const tag = (req.body?.tag || '').trim().toUpperCase();
  const description = (req.body?.description || '').trim().substring(0, 140);

  if (!NAME_REGEX.test(name)) {
    return res.status(400).json({ ok: false, error: 'El nombre del clan debe tener entre 3 y 24 caracteres.' });
  }
  if (!TAG_REGEX.test(tag)) {
    return res.status(400).json({ ok: false, error: 'La etiqueta debe tener 2-5 letras o números, sin espacios.' });
  }
  if (getMembership(req.license.id)) {
    return res.status(400).json({ ok: false, error: 'Ya perteneces a un clan. Sal de él antes de crear otro.' });
  }

  const tagTaken = db.prepare('SELECT id FROM guilds WHERE tag = ? COLLATE NOCASE').get(tag);
  if (tagTaken) {
    return res.status(409).json({ ok: false, error: 'Esa etiqueta ya está en uso por otro clan.' });
  }

  const insert = db
    .prepare('INSERT INTO guilds (name, tag, description, leader_license_id) VALUES (?, ?, ?, ?)')
    .run(name, tag, description, req.license.id);
  const guildId = insert.lastInsertRowid;

  db.prepare('INSERT INTO guild_members (license_id, guild_id) VALUES (?, ?)').run(req.license.id, guildId);

  const guild = getGuildById(guildId);
  res.json({ ok: true, guild: guildPayload(guild), members: membersPayload(guildId) });
});

// POST /api/guild/join  body: { guildId }  (requiere token)
router.post('/join', requireToken, (req, res) => {
  const { guildId } = req.body || {};
  if (!Number.isInteger(guildId)) {
    return res.status(400).json({ ok: false, error: 'Clan inválido.' });
  }
  if (getMembership(req.license.id)) {
    return res.status(400).json({ ok: false, error: 'Ya perteneces a un clan. Sal de él antes de unirte a otro.' });
  }
  const guild = getGuildById(guildId);
  if (!guild) {
    return res.status(404).json({ ok: false, error: 'Ese clan ya no existe.' });
  }
  if (memberCount(guildId) >= maxMembersForLevel(guild.level)) {
    return res.status(400).json({ ok: false, error: 'Ese clan ya está completo.' });
  }

  db.prepare('INSERT INTO guild_members (license_id, guild_id) VALUES (?, ?)').run(req.license.id, guildId);

  const username = getUsername(req.license.id);
  db.prepare(
    `INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, NULL, 'Sistema', ?)`
  ).run(guildId, `${username} se ha unido al clan.`);

  res.json({ ok: true, guild: guildPayload(guild), members: membersPayload(guildId) });
});

// POST /api/guild/leave  (requiere token)
// Si el que sale es el líder, el clan pasa automáticamente al miembro más
// antiguo. Si el que sale es el último miembro, el clan se disuelve entero
// (incluido su historial de chat).
router.post('/leave', requireToken, (req, res) => {
  const membership = getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guildId = membership.guild_id;
  const guild = getGuildById(guildId);

  db.prepare('DELETE FROM guild_members WHERE license_id = ?').run(req.license.id);

  const remaining = db
    .prepare('SELECT license_id FROM guild_members WHERE guild_id = ? ORDER BY joined_at ASC LIMIT 1')
    .get(guildId);

  if (!remaining) {
    // Era el último miembro: disolver el clan.
    db.prepare('DELETE FROM guild_messages WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM guilds WHERE id = ?').run(guildId);
    return res.json({ ok: true, disbanded: true });
  }

  if (guild && guild.leader_license_id === req.license.id) {
    db.prepare('UPDATE guilds SET leader_license_id = ? WHERE id = ?').run(remaining.license_id, guildId);
    const username = getUsername(remaining.license_id);
    db.prepare(
      `INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, NULL, 'Sistema', ?)`
    ).run(guildId, `${username} es ahora el líder del clan.`);
  }

  res.json({ ok: true, disbanded: false });
});

// POST /api/guild/kick  body: { licenseId }  (requiere token, solo el líder)
router.post('/kick', requireToken, (req, res) => {
  const { licenseId } = req.body || {};
  const membership = getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guild = getGuildById(membership.guild_id);
  if (!guild || guild.leader_license_id !== req.license.id) {
    return res.status(403).json({ ok: false, error: 'Solo el líder del clan puede expulsar miembros.' });
  }
  if (!Number.isInteger(licenseId) || licenseId === req.license.id) {
    return res.status(400).json({ ok: false, error: 'Miembro inválido.' });
  }
  const target = db
    .prepare('SELECT * FROM guild_members WHERE license_id = ? AND guild_id = ?')
    .get(licenseId, guild.id);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'Ese jugador no está en tu clan.' });
  }

  db.prepare('DELETE FROM guild_members WHERE license_id = ?').run(licenseId);
  const username = getUsername(licenseId);
  db.prepare(
    `INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, NULL, 'Sistema', ?)`
  ).run(guild.id, `${username} ha sido expulsado del clan.`);

  res.json({ ok: true, guild: guildPayload(guild), members: membersPayload(guild.id) });
});

// POST /api/guild/donate  body: { amount }  (requiere token, requiere estar en un clan)
// Descuenta `amount` monedas al jugador y las suma al banco del clan; esa
// misma cantidad cuenta como xp de clan (1 moneda donada = 1 xp), y el clan
// sube de nivel automáticamente cuando alcanza el umbral (puede subir varios
// niveles de golpe si la donación es grande). El banco del clan es acumulado
// y no se gasta al subir de nivel: solo la xp se consume nivel a nivel.
router.post('/donate', requireToken, (req, res) => {
  const amount = Math.trunc(Number(req.body?.amount));
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_DONATION) {
    return res.status(400).json({ ok: false, error: `La donación debe ser un número entero entre 1 y ${MAX_DONATION}.` });
  }

  const membership = getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }

  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  if (!stats || stats.coins < amount) {
    return res.status(400).json({ ok: false, error: 'No tienes monedas suficientes.' });
  }

  let guild = getGuildById(membership.guild_id);
  if (!guild) {
    return res.status(404).json({ ok: false, error: 'Tu clan ya no existe.' });
  }

  // Sube de nivel tantas veces como haga falta con la xp acumulada (por si
  // dona de golpe una cantidad grande que cubre varios niveles seguidos).
  let level = guild.level;
  let xp = guild.xp + amount;
  while (xp >= xpToNextLevel(level)) {
    xp -= xpToNextLevel(level);
    level += 1;
  }

  db.prepare('UPDATE player_stats SET coins = coins - ?, updated_at = datetime(\'now\') WHERE license_id = ?').run(
    amount,
    req.license.id
  );
  db.prepare('UPDATE guilds SET bank_coins = bank_coins + ?, level = ?, xp = ? WHERE id = ?').run(
    amount,
    level,
    xp,
    guild.id
  );
  db.prepare('UPDATE guild_members SET total_donated = total_donated + ? WHERE license_id = ?').run(
    amount,
    req.license.id
  );

  if (level > guild.level) {
    const username = getUsername(req.license.id);
    db.prepare(
      `INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, NULL, 'Sistema', ?)`
    ).run(guild.id, `${username} ha donado ${amount} monedas. ¡El clan ha subido a nivel ${level}!`);
  }

  guild = getGuildById(guild.id);
  const newCoins = stats.coins - amount;
  res.json({ ok: true, guild: guildPayload(guild), coins: newCoins });
});

// GET /api/guild/chat?after=0  (requiere token)
// Devuelve mensajes del clan del jugador con id > after (por defecto, los
// últimos CHAT_HISTORY_LIMIT). El cliente hace polling con el id más alto
// que ya tiene para no repetir mensajes.
router.get('/chat', requireToken, (req, res) => {
  const membership = getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const after = Number.parseInt(req.query.after, 10);

  let rows;
  if (Number.isInteger(after) && after > 0) {
    rows = db
      .prepare('SELECT * FROM guild_messages WHERE guild_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(membership.guild_id, after, CHAT_HISTORY_LIMIT);
  } else {
    rows = db
      .prepare('SELECT * FROM guild_messages WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
      .all(membership.guild_id, CHAT_HISTORY_LIMIT)
      .reverse();
  }

  res.json({
    ok: true,
    messages: rows.map((m) => ({
      id: m.id,
      licenseId: m.license_id,
      username: m.username,
      message: m.message,
      createdAt: m.created_at,
      system: m.license_id === null,
    })),
  });
});

// POST /api/guild/chat  body: { message }  (requiere token)
router.post('/chat', requireToken, (req, res) => {
  const message = (req.body?.message || '').toString().trim();
  if (message === '' || message.length > MESSAGE_MAX_LENGTH) {
    return res.status(400).json({ ok: false, error: `El mensaje debe tener entre 1 y ${MESSAGE_MAX_LENGTH} caracteres.` });
  }
  const membership = getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }

  const username = getUsername(req.license.id);
  const insert = db
    .prepare('INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, ?, ?, ?)')
    .run(membership.guild_id, req.license.id, username, message);

  res.json({
    ok: true,
    message: {
      id: insert.lastInsertRowid,
      licenseId: req.license.id,
      username,
      message,
      createdAt: new Date().toISOString(),
      system: false,
    },
  });
});

module.exports = router;
