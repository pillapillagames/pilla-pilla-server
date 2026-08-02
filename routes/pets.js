// Rutas de la Zona de Mascotas (Fase 5a). Mismo patrón que routes/house.js.
//
// Montado en server.js:
//   app.use('/api/player/pets', petRoutes);
//
// Expone:
//   GET  /api/player/pets        -> { ok, pets: [...], coins }
//   POST /api/player/pets/adopt  -> body { speciesId: "brisa", nickname?: "..." }
//   POST /api/player/pets/train  -> body { petId: "..." }
//   POST /api/player/pets/equip  -> body { petId: "..." }

const express = require('express');
const crypto = require('crypto');
const db = require('../db/db');
const { requireToken } = require('./license');
const { getSpecies, trainingCost, isMaxLevel } = require('../data/petCatalog');

const router = express.Router();

function serializePet(row) {
  return {
    petId: row.pet_id,
    speciesId: row.species_id,
    level: row.level,
    nickname: row.nickname,
    equipped: !!row.equipped,
  };
}

function getCoins(licenseId) {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(licenseId);
  return stats ? stats.coins : 0;
}

// GET /api/player/pets
router.get('/', requireToken, (req, res) => {
  const petRows = db
    .prepare('SELECT pet_id, species_id, level, nickname, equipped FROM player_pets WHERE license_id = ?')
    .all(req.license.id);

  res.json({
    ok: true,
    pets: petRows.map(serializePet),
    coins: getCoins(req.license.id),
  });
});

// POST /api/player/pets/adopt  body: { speciesId, nickname? }
router.post('/adopt', requireToken, (req, res) => {
  const speciesId = req.body?.speciesId;
  const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.slice(0, 24) : '';
  const species = getSpecies(speciesId);
  if (!species) return res.status(400).json({ ok: false, error: 'Especie desconocida' });

  // Un jugador solo puede tener una mascota de cada especie. Sin este check,
  // /adopt no ponía ningún límite y se podían acumular varias "brisa", por
  // ejemplo, gastando monedas en algo que no aporta nada nuevo.
  const alreadyOwned = db
    .prepare('SELECT 1 FROM player_pets WHERE license_id = ? AND species_id = ?')
    .get(req.license.id, speciesId);
  if (alreadyOwned) {
    return res.status(400).json({ ok: false, error: 'Ya tienes una mascota de esa especie' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  const currentCoins = stats ? stats.coins : 0;
  if (currentCoins < species.price) {
    return res.status(400).json({ ok: false, error: 'No tienes suficientes monedas' });
  }

  const existingCount = db
    .prepare('SELECT COUNT(*) as total FROM player_pets WHERE license_id = ?')
    .get(req.license.id);
  const isFirstPet = !existingCount || Number(existingCount.total) === 0;

  const newCoins = currentCoins - species.price;
  db.prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`).run(
    newCoins,
    req.license.id
  );

  const petId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO player_pets (pet_id, license_id, species_id, level, nickname, equipped)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run(petId, req.license.id, speciesId, nickname, isFirstPet ? 1 : 0);

  res.json({
    ok: true,
    coins: newCoins,
    pet: serializePet({
      pet_id: petId,
      species_id: speciesId,
      level: 1,
      nickname,
      equipped: isFirstPet ? 1 : 0,
    }),
  });
});

// POST /api/player/pets/train  body: { petId }
router.post('/train', requireToken, (req, res) => {
  const petId = req.body?.petId;
  if (!petId) return res.status(400).json({ ok: false, error: 'pet_id inválido' });

  const petRow = db
    .prepare(
      'SELECT pet_id, species_id, level, nickname, equipped FROM player_pets WHERE pet_id = ? AND license_id = ?'
    )
    .get(petId, req.license.id);
  if (!petRow) return res.status(404).json({ ok: false, error: 'Mascota no encontrada' });
  if (isMaxLevel(petRow.level)) {
    return res.status(400).json({ ok: false, error: 'La mascota ya está al nivel máximo' });
  }

  const cost = trainingCost(petRow.level);
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  const currentCoins = stats ? stats.coins : 0;
  if (currentCoins < cost) {
    return res.status(400).json({ ok: false, error: 'No tienes suficientes monedas' });
  }

  const newCoins = currentCoins - cost;
  const newLevel = petRow.level + 1;
  db.prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`).run(
    newCoins,
    req.license.id
  );
  db.prepare('UPDATE player_pets SET level = ? WHERE pet_id = ?').run(newLevel, petId);

  res.json({
    ok: true,
    coins: newCoins,
    pet: serializePet({ ...petRow, level: newLevel }),
  });
});

// POST /api/player/pets/equip  body: { petId }
// Solo una mascota equipada a la vez: desequipa el resto primero.
router.post('/equip', requireToken, (req, res) => {
  const petId = req.body?.petId;
  if (!petId) return res.status(400).json({ ok: false, error: 'pet_id inválido' });

  const petRow = db
    .prepare('SELECT pet_id FROM player_pets WHERE pet_id = ? AND license_id = ?')
    .get(petId, req.license.id);
  if (!petRow) return res.status(404).json({ ok: false, error: 'Mascota no encontrada' });

  db.prepare('UPDATE player_pets SET equipped = 0 WHERE license_id = ?').run(req.license.id);
  db.prepare('UPDATE player_pets SET equipped = 1 WHERE pet_id = ?').run(petId);

  res.json({ ok: true });
});

module.exports = router;
