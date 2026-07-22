const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');

const router = express.Router();

// Precios de las skins de la tienda. Tienen que coincidir con el array SKINS
// de scripts/player_data.gd en el cliente. El servidor es quien manda sobre
// el precio real (el cliente solo lo usa para pintar el botón), así que si
// cambias un precio aquí, cámbialo también allí para que no se desincronicen.
const SKIN_PRICES = [0, 50, 50, 100, 150, 150];

// Rangos calculados a partir del "elo" (que hace de contador de trofeos).
// La columna "rank" de la base de datos ya no se usa: el rango siempre se
// calcula al vuelo a partir de los trofeos actuales, así nunca sale
// "Sin rango" y no hace falta sincronizar dos valores por separado.
// Cada rango principal tiene 4 divisiones de 300 trofeos cada una (IV la más
// baja, I la más alta dentro del rango). Por encima de Sombra los rangos de
// "élite" ya no tienen divisiones. Los nombres siguen la temática del propio
// juego: empiezas siendo fácil de pillar (Novato) y acabas siendo casi
// imposible de atrapar (Dios del Pillaje).
// Ordenado de mayor a menor umbral para que el primero que cumpla "gane".
const RANK_TIERS = [
  { min: 12000, name: 'Dios de PillaPilla', emoji: '👑' },
  { min: 10000, name: 'Mito', emoji: '🌟' },
  { min: 9000, name: 'Leyenda de PillaPilla', emoji: '🏆' },
  { min: 7500, name: 'Intocable', emoji: '⚡' },
  { min: 6000, name: 'Fantasma', emoji: '👻' },
  { min: 5700, name: 'Sombra I', emoji: '🌑' },
  { min: 5400, name: 'Sombra II', emoji: '🌑' },
  { min: 5100, name: 'Sombra III', emoji: '🌑' },
  { min: 4800, name: 'Sombra IV', emoji: '🌑' },
  { min: 4500, name: 'Cazador I', emoji: '🎯' },
  { min: 4200, name: 'Cazador II', emoji: '🎯' },
  { min: 3900, name: 'Cazador III', emoji: '🎯' },
  { min: 3600, name: 'Cazador IV', emoji: '🎯' },
  { min: 3300, name: 'Escurridizo I', emoji: '💨' },
  { min: 3000, name: 'Escurridizo II', emoji: '💨' },
  { min: 2700, name: 'Escurridizo III', emoji: '💨' },
  { min: 2400, name: 'Escurridizo IV', emoji: '💨' },
  { min: 2100, name: 'Corredor I', emoji: '🏃' },
  { min: 1800, name: 'Corredor II', emoji: '🏃' },
  { min: 1500, name: 'Corredor III', emoji: '🏃' },
  { min: 1200, name: 'Corredor IV', emoji: '🏃' },
  { min: 900, name: 'Novato I', emoji: '🐣' },
  { min: 600, name: 'Novato II', emoji: '🐣' },
  { min: 300, name: 'Novato III', emoji: '🐣' },
  { min: 0, name: 'Novato IV', emoji: '🐣' },
];

function getRank(elo) {
  const safeElo = Number.isFinite(elo) ? elo : 0;
  const tier = RANK_TIERS.find((t) => safeElo >= t.min);
  return `${tier.emoji} ${tier.name}`;
}

function parseUnlockedSkins(raw) {
  try {
    const arr = JSON.parse(raw || '[0]');
    if (Array.isArray(arr)) return arr;
  } catch (e) {
    // Ignora datos corruptos y cae al valor por defecto
  }
  return [0];
}

// --- Pase de Batalla y Torneo mensual ---
// Mismas tablas de recompensas que scripts/player_data.gd en el cliente. Si
// cambias una recompensa, cámbiala también allí para que no se desincronicen
// (el cliente solo las usa para pintar la pantalla; el servidor es quien
// manda de verdad sobre si se puede reclamar y qué se da).
const BATTLE_PASS_XP_PER_TIER = 150;
const BATTLE_PASS_TIERS = [
  { coins: 20 },
  { coins: 20 },
  { coins: 30 },
  { coins: 30 },
  { coins: 50, skin: 1 },   // Lava
  { coins: 30 },
  { coins: 30 },
  { coins: 40 },
  { coins: 40 },
  { coins: 80, skin: 2 },   // Esmeralda
  { coins: 40 },
  { coins: 40 },
  { coins: 50 },
  { coins: 50 },
  { coins: 100, skin: 3 },  // Oro
  { coins: 50 },
  { coins: 50 },
  { coins: 60 },
  { coins: 60 },
  { coins: 150, skin: 4 },  // Fantasma (gran premio final)
];

const TOURNAMENT_POINTS_1ST = 50;
const TOURNAMENT_POINTS_2ND = 25;
const TOURNAMENT_POINTS_3RD = 10;
const TOURNAMENT_POINTS_PARTICIPATION = 5;

const TOURNAMENT_MILESTONES = [
  { points: 50, coins: 20 },
  { points: 100, coins: 30 },
  { points: 200, coins: 50, skin: 2 },   // Esmeralda
  { points: 350, coins: 60 },
  { points: 500, coins: 100, skin: 3 },  // Oro
  { points: 750, coins: 150 },
  { points: 1000, coins: 250, skin: 5 }, // Sombra (gran premio final)
];

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseJsonArray(raw, fallback = []) {
  try {
    const arr = JSON.parse(raw ?? JSON.stringify(fallback));
    if (Array.isArray(arr)) return arr;
  } catch (e) {
    // Ignora datos corruptos y cae al valor por defecto
  }
  return fallback;
}

function battlePassTierFromXp(xp) {
  return Math.max(0, Math.min(BATTLE_PASS_TIERS.length, Math.floor(xp / BATTLE_PASS_XP_PER_TIER)));
}

// Si ha cambiado el mes desde la última vez que se tocaron estos datos,
// arranca una temporada nueva para el pase de batalla y el torneo: reinicia
// progreso y reclamos, pero las recompensas ya reclamadas se quedan ganadas
// para siempre (no se tocan monedas ni skins). Autoritativo: el servidor
// decide cuándo cambia el mes, no el cliente. Devuelve la fila de stats ya
// al día (recién leída o recién reseteada).
function ensureSeason(licenseId) {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  let stats = db.prepare('SELECT * FROM player_stats WHERE license_id = ?').get(licenseId);
  const cur = currentMonthKey();
  const updates = {};
  if (stats.battle_pass_month !== cur) {
    updates.battle_pass_month = cur;
    updates.battle_pass_xp = 0;
    updates.battle_pass_claimed = '[]';
  }
  if (stats.tournament_month !== cur) {
    updates.tournament_month = cur;
    updates.tournament_points = 0;
    updates.tournament_claimed = '[]';
  }
  if (Object.keys(updates).length > 0) {
    const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE player_stats SET ${setClause}, updated_at = datetime('now') WHERE license_id = ?`)
      .run(...Object.values(updates), licenseId);
    stats = db.prepare('SELECT * FROM player_stats WHERE license_id = ?').get(licenseId);
  }
  return stats;
}

// Bloque de campos de temporada listo para meter en cualquier respuesta JSON.
function seasonPayload(stats) {
  return {
    battlePassXp: stats.battle_pass_xp,
    battlePassTier: battlePassTierFromXp(stats.battle_pass_xp),
    battlePassClaimed: parseJsonArray(stats.battle_pass_claimed),
    tournamentPoints: stats.tournament_points,
    tournamentClaimed: parseJsonArray(stats.tournament_claimed),
    tournamentWins: stats.tournament_wins,
    tournamentMatches: stats.tournament_matches,
    seasonMonth: currentMonthKey(),
  };
}

// GET /api/player/stats  (requiere token de licencia, igual que /api/game/manifest)
router.get('/stats', requireToken, (req, res) => {
  const stats = ensureSeason(req.license.id);

  res.json({
    ok: true,
    username: stats.username || `Jugador${req.license.id}`,
    level: stats.level,
    xp: stats.xp,
    xpToNextLevel: stats.xp_to_next_level,
    coins: stats.coins,
    equippedSkin: stats.equipped_skin,
    rank: getRank(stats.elo),
    elo: stats.elo,
    matchesPlayed: stats.matches_played,
    wins: stats.wins,
    bestSurvivalSeconds: stats.best_survival_seconds,
    totalCatches: stats.total_catches,
    unlockedSkins: parseUnlockedSkins(stats.unlocked_skins),
    ...seasonPayload(stats),
  });
});

// POST /api/player/nickname  body: { nickname }  (requiere token)
// Guarda el nickname de forma permanente, vinculado a la licencia del jugador.
const NICKNAME_REGEX = /^[a-zA-Z0-9_]{3,16}$/; // letras, números y "_", 3-16 caracteres

router.post('/nickname', requireToken, (req, res) => {
  const nickname = (req.body?.nickname || '').trim();

  if (!NICKNAME_REGEX.test(nickname)) {
    return res.status(400).json({
      ok: false,
      error: 'El nickname debe tener 3-16 caracteres: letras, números o "_".',
    });
  }

  // Comprueba que no lo esté usando ya otro jugador (comparación insensible a mayúsculas)
  const taken = db
    .prepare('SELECT license_id FROM player_stats WHERE lower(username) = lower(?) AND license_id != ?')
    .get(nickname, req.license.id);

  if (taken) {
    return res.status(409).json({ ok: false, error: 'Ese nickname ya está en uso.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  db.prepare(
    `UPDATE player_stats SET username = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(nickname, req.license.id);

  res.json({ ok: true, username: nickname });
});

// POST /api/player/match-result  (requiere token)
// body: {
//   coinsEarned: number,       // monedas ganadas en ESTA partida
//   xpEarned: number,          // xp ganada en ESTA partida
//   survivalSeconds: number,   // cuánto sobrevivió en ESTA partida
//   caught: number,            // a cuántos jugadores pilló en ESTA partida
//   won: boolean               // si ganó la partida
// }
// El servidor SUMA estos valores a los totales guardados, no los reemplaza.
router.post('/match-result', requireToken, (req, res) => {
  const {
    coinsEarned = 0,
    xpEarned = 0,
    survivalSeconds = 0,
    caught = 0,
    won = false,
    eloDelta = 0,
    tournamentPlacement = -1, // 0 = 1º puesto, 1 = 2º... -1 = no jugó Modo Torneo
  } = req.body || {};

  // Validación básica: todo debe ser un número no negativo y razonable,
  // para evitar que un cliente manipulado mande valores absurdos.
  const nums = { coinsEarned, xpEarned, survivalSeconds, caught };
  for (const [key, value] of Object.entries(nums)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) {
      return res.status(400).json({ ok: false, error: `Valor inválido: ${key}` });
    }
  }
  // eloDelta sí puede ser negativo (perder rating), pero acotado a un rango
  // razonable por partida para que un cliente manipulado no pueda inflarse
  // el rating de golpe.
  if (typeof eloDelta !== 'number' || !Number.isFinite(eloDelta) || eloDelta < -200 || eloDelta > 200) {
    return res.status(400).json({ ok: false, error: 'Valor inválido: eloDelta' });
  }
  // El puesto solo tiene sentido entre -1 (no torneo) y un puñado de
  // jugadores; acotado generosamente por si en el futuro hay salas grandes.
  if (
    typeof tournamentPlacement !== 'number' ||
    !Number.isInteger(tournamentPlacement) ||
    tournamentPlacement < -1 ||
    tournamentPlacement > 63
  ) {
    return res.status(400).json({ ok: false, error: 'Valor inválido: tournamentPlacement' });
  }

  const stats = ensureSeason(req.license.id);

  // Suma monedas, victorias, partidas jugadas y pilladas totales
  let newCoins = stats.coins + Math.round(coinsEarned);
  let newMatches = stats.matches_played + 1;
  let newWins = stats.wins + (won ? 1 : 0);
  let newCatches = stats.total_catches + Math.round(caught);
  let newBestSurvival = Math.max(stats.best_survival_seconds, Math.round(survivalSeconds));
  let newElo = Math.max(0, stats.elo + Math.round(eloDelta));

  // Suma XP y sube de nivel si hace falta (puede subir varios niveles de golpe)
  let newXp = stats.xp + Math.round(xpEarned);
  let newLevel = stats.level;
  let newXpToNext = stats.xp_to_next_level;

  while (newXp >= newXpToNext) {
    newXp -= newXpToNext;
    newLevel += 1;
    newXpToNext = Math.round(newXpToNext * 1.15) + 20; // cada nivel pide un poco más
  }

  // El pase de batalla avanza con la MISMA XP que da la partida, en
  // cualquier modo (ranked o no): es progresión aparte del nivel del jugador.
  const newBattlePassXp = stats.battle_pass_xp + Math.round(xpEarned);

  // Modo Torneo: solo puntúa si el cliente mandó un puesto real (>= 0), lo
  // que solo pasa si la partida se jugó con "Modo Torneo" activo en la sala.
  let tournamentPointsEarned = 0;
  let newTournamentPoints = stats.tournament_points;
  let newTournamentWins = stats.tournament_wins;
  let newTournamentMatches = stats.tournament_matches;
  if (tournamentPlacement >= 0) {
    if (tournamentPlacement === 0) {
      tournamentPointsEarned = TOURNAMENT_POINTS_1ST;
      newTournamentWins += 1;
    } else if (tournamentPlacement === 1) {
      tournamentPointsEarned = TOURNAMENT_POINTS_2ND;
    } else if (tournamentPlacement === 2) {
      tournamentPointsEarned = TOURNAMENT_POINTS_3RD;
    } else {
      tournamentPointsEarned = TOURNAMENT_POINTS_PARTICIPATION;
    }
    newTournamentPoints += tournamentPointsEarned;
    newTournamentMatches += 1;
  }

  db.prepare(
    `UPDATE player_stats SET
       coins = ?,
       xp = ?,
       level = ?,
       xp_to_next_level = ?,
       matches_played = ?,
       wins = ?,
       total_catches = ?,
       best_survival_seconds = ?,
       elo = ?,
       battle_pass_xp = ?,
       tournament_points = ?,
       tournament_wins = ?,
       tournament_matches = ?,
       updated_at = datetime('now')
     WHERE license_id = ?`
  ).run(
    newCoins,
    newXp,
    newLevel,
    newXpToNext,
    newMatches,
    newWins,
    newCatches,
    newBestSurvival,
    newElo,
    newBattlePassXp,
    newTournamentPoints,
    newTournamentWins,
    newTournamentMatches,
    req.license.id
  );

  res.json({
    ok: true,
    coins: newCoins,
    xp: newXp,
    level: newLevel,
    xpToNextLevel: newXpToNext,
    matchesPlayed: newMatches,
    wins: newWins,
    totalCatches: newCatches,
    bestSurvivalSeconds: newBestSurvival,
    elo: newElo,
    rank: getRank(newElo),
    leveledUp: newLevel > stats.level,
    tournamentPointsEarned,
    ...seasonPayload({
      ...stats,
      battle_pass_xp: newBattlePassXp,
      tournament_points: newTournamentPoints,
      tournament_wins: newTournamentWins,
      tournament_matches: newTournamentMatches,
    }),
  });
});

// POST /api/player/sync  (requiere token)
// Sincronización ÚNICA: sobrescribe las stats del servidor con el progreso
// que el jugador ya tenía guardado localmente antes de que existiera esta
// sincronización (nivel, monedas, xp, partidas...). El propio juego se
// encarga de no llamar a esto más de una vez por dispositivo.
router.post('/sync', requireToken, (req, res) => {
  const {
    coins = 0,
    level = 1,
    xp = 0,
    xpToNextLevel = 100,
    matchesPlayed = 0,
    totalCatches = 0,
    bestSurvivalSeconds = 0,
    elo = 0,
  } = req.body || {};

  const nums = { coins, level, xp, xpToNextLevel, matchesPlayed, totalCatches, bestSurvivalSeconds, elo };
  for (const [key, value] of Object.entries(nums)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000000) {
      return res.status(400).json({ ok: false, error: `Valor inválido: ${key}` });
    }
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  db.prepare(
    `UPDATE player_stats SET
       coins = ?,
       level = ?,
       xp = ?,
       xp_to_next_level = ?,
       matches_played = ?,
       total_catches = ?,
       best_survival_seconds = ?,
       elo = ?,
       updated_at = datetime('now')
     WHERE license_id = ?`
  ).run(coins, level, xp, xpToNextLevel, matchesPlayed, totalCatches, bestSurvivalSeconds, elo, req.license.id);

  res.json({ ok: true });
});

// POST /api/player/buy-skin  body: { skinIndex }  (requiere token)
// Compra autoritativa: el servidor comprueba precio y monedas, resta y
// guarda el skin desbloqueado. El cliente NUNCA decide si la compra es
// válida, solo la solicita y aplica lo que el servidor confirme.
router.post('/buy-skin', requireToken, (req, res) => {
  const { skinIndex } = req.body || {};

  if (typeof skinIndex !== 'number' || !Number.isInteger(skinIndex) || skinIndex < 0 || skinIndex >= SKIN_PRICES.length) {
    return res.status(400).json({ ok: false, error: 'Skin inválida.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT * FROM player_stats WHERE license_id = ?').get(req.license.id);

  const unlocked = parseUnlockedSkins(stats.unlocked_skins);

  if (unlocked.includes(skinIndex)) {
    // Ya la tenía (p.ej. reintento tras un fallo de red): no cobra dos veces.
    return res.json({ ok: true, alreadyOwned: true, coins: stats.coins, unlockedSkins: unlocked });
  }

  const price = SKIN_PRICES[skinIndex];
  if (stats.coins < price) {
    return res.status(400).json({ ok: false, error: 'No tienes monedas suficientes.' });
  }

  const newCoins = stats.coins - price;
  unlocked.push(skinIndex);

  db.prepare(
    `UPDATE player_stats SET coins = ?, unlocked_skins = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(unlocked), req.license.id);

  db.prepare(
    `INSERT INTO purchases (license_id, item_type, item_index, price, coins_after) VALUES (?, 'skin', ?, ?, ?)`
  ).run(req.license.id, skinIndex, price, newCoins);

  res.json({ ok: true, coins: newCoins, unlockedSkins: unlocked });
});

// POST /api/player/claim-battlepass-tier  body: { tier }  (requiere token)
// Reclamo autoritativo de una recompensa del Pase de Batalla: el servidor
// comprueba que de verdad se alcanzó ese nivel (con la XP guardada, no la
// que diga el cliente) y que no se reclamó ya esta temporada.
router.post('/claim-battlepass-tier', requireToken, (req, res) => {
  const { tier } = req.body || {};

  if (!Number.isInteger(tier) || tier < 1 || tier > BATTLE_PASS_TIERS.length) {
    return res.status(400).json({ ok: false, error: 'Nivel de pase inválido.' });
  }

  const stats = ensureSeason(req.license.id);
  const claimed = parseJsonArray(stats.battle_pass_claimed);

  if (claimed.includes(tier)) {
    return res.status(400).json({ ok: false, error: 'Ya reclamaste ese nivel esta temporada.' });
  }

  const currentTier = battlePassTierFromXp(stats.battle_pass_xp);
  if (currentTier < tier) {
    return res.status(400).json({ ok: false, error: 'Todavía no has alcanzado ese nivel del pase.' });
  }

  const reward = BATTLE_PASS_TIERS[tier - 1];
  const unlocked = parseUnlockedSkins(stats.unlocked_skins);
  const newCoins = stats.coins + (reward.coins || 0);
  if (typeof reward.skin === 'number' && !unlocked.includes(reward.skin)) {
    unlocked.push(reward.skin);
  }
  claimed.push(tier);

  db.prepare(
    `UPDATE player_stats SET coins = ?, unlocked_skins = ?, battle_pass_claimed = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(unlocked), JSON.stringify(claimed), req.license.id);

  res.json({ ok: true, coins: newCoins, unlockedSkins: unlocked, battlePassClaimed: claimed });
});

// POST /api/player/claim-tournament-milestone  body: { milestoneIndex }  (requiere token)
// Igual que el reclamo del pase, pero para los hitos de puntos del torneo
// mensual (índice 0-indexado dentro de TOURNAMENT_MILESTONES).
router.post('/claim-tournament-milestone', requireToken, (req, res) => {
  const { milestoneIndex } = req.body || {};

  if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= TOURNAMENT_MILESTONES.length) {
    return res.status(400).json({ ok: false, error: 'Hito de torneo inválido.' });
  }

  const stats = ensureSeason(req.license.id);
  const claimed = parseJsonArray(stats.tournament_claimed);

  if (claimed.includes(milestoneIndex)) {
    return res.status(400).json({ ok: false, error: 'Ya reclamaste ese hito esta temporada.' });
  }

  const milestone = TOURNAMENT_MILESTONES[milestoneIndex];
  if (stats.tournament_points < milestone.points) {
    return res.status(400).json({ ok: false, error: 'Todavía no tienes suficientes puntos de torneo.' });
  }

  const unlocked = parseUnlockedSkins(stats.unlocked_skins);
  const newCoins = stats.coins + (milestone.coins || 0);
  if (typeof milestone.skin === 'number' && !unlocked.includes(milestone.skin)) {
    unlocked.push(milestone.skin);
  }
  claimed.push(milestoneIndex);

  db.prepare(
    `UPDATE player_stats SET coins = ?, unlocked_skins = ?, tournament_claimed = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(unlocked), JSON.stringify(claimed), req.license.id);

  res.json({ ok: true, coins: newCoins, unlockedSkins: unlocked, tournamentClaimed: claimed });
});

module.exports = router;
