require('dotenv').config();

const express = require('express');
const { ensureSchema } = require('./db/pg');
const { startShopWatcher } = require('./lib/shopWatcher');

const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/session');
const { router: licenseRoutes } = require('./routes/license');
const statusRoutes = require('./routes/status');
const versionRoutes = require('./routes/version');
const downloadRoutes = require('./routes/download');
const playerRoutes = require('./routes/player');
const shopRoutes = require('./routes/shop');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json());

// --- Rutas públicas de login (fuera de /api, las visita el navegador) ---
app.use('/auth', authRoutes);

// --- Rutas /api/* ---
// session.js declara internamente '/session/validate' y '/redeem', por eso
// se monta directamente en '/api' (no en '/api/session').
app.use('/api', sessionRoutes);

// license.js, status.js y version.js declaran internamente '/activate',
// '/validate', '/manifest', '/status' y '/version': todas viven bajo
// '/api/game' (coincide con lo que llama el launcher: /api/game/manifest,
// /api/game/status, /api/game/version, /api/game/download).
app.use('/api/game', licenseRoutes);
app.use('/api/game', statusRoutes);
app.use('/api/game', versionRoutes);
app.use('/api/game', downloadRoutes);

app.use('/api/player', playerRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'pilla-pilla-server' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await ensureSchema();
  } catch (err) {
    console.error('Error preparando el esquema de Postgres:', err);
  }

  startShopWatcher();

  app.listen(PORT, () => {
    console.log(`pilla-pilla-server escuchando en el puerto ${PORT}`);
  });
}

start();
