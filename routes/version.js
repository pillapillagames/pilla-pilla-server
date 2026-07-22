const express = require('express');
const router = express.Router();

// GITHUB_RELEASES_BASE_URL = https://github.com/<owner>/<repo>/releases/download/v1.4.1
const GITHUB_RELEASES_BASE_URL = process.env.GITHUB_RELEASES_BASE_URL;

// GET /api/game/version
// Devuelve la versión del launcher (variable de entorno LAUNCHER_VERSION)
// y la versión del juego, extraída de GITHUB_RELEASES_BASE_URL.
// No requiere token: se debe poder consultar antes de iniciar sesión.
router.get('/version', (req, res) => {
  const match = GITHUB_RELEASES_BASE_URL
    ? GITHUB_RELEASES_BASE_URL.match(/\/v?(\d+\.\d+\.\d+)\/?$/)
    : null;

  res.json({
    ok: true,
    launcherVersion: process.env.LAUNCHER_VERSION || null,
    gameVersion: match ? match[1] : null
  });
});

module.exports = router;
