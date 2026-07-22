const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireToken } = require('./license');

const router = express.Router();
const RELEASES_DIR = path.resolve(process.env.RELEASES_DIR || './releases');

// Si está configurada, los archivos grandes se sirven proxeando desde GitHub Releases
// en vez de buscarlos en el disco local (útil en hostings como Railway que no tienen
// espacio persistente grande). Formato esperado, ej:
// GITHUB_RELEASES_BASE_URL=https://github.com/propelfundingflow-ops/pilla-pilla-server/releases/download/v1.0.0
const GITHUB_RELEASES_BASE_URL = process.env.GITHUB_RELEASES_BASE_URL;

// GET /api/game/download?version=1.0.0&file=ruta/relativa/al/archivo
router.get('/download', requireToken, async (req, res) => {
  const { version, file } = req.query;
  if (!version || !file) {
    return res.status(400).json({ ok: false, error: 'Faltan parámetros version o file.' });
  }

  // Opción 1: proxear desde GitHub Releases (archivos grandes)
  if (GITHUB_RELEASES_BASE_URL) {
    const remoteUrl = `${GITHUB_RELEASES_BASE_URL}/${encodeURIComponent(file)}`;
    try {
      const upstream = await fetch(remoteUrl);
      if (!upstream.ok || !upstream.body) {
        return res.status(404).json({ ok: false, error: 'Archivo no encontrado en Releases.' });
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'Error descargando desde Releases: ' + err.message });
    }
  }

  // Opción 2 (fallback): servir desde el disco local del servidor
  const versionDir = path.resolve(RELEASES_DIR, version);
  const target = path.resolve(versionDir, file);

  if (!target.startsWith(versionDir + path.sep) || !fs.existsSync(target)) {
    return res.status(404).json({ ok: false, error: 'Archivo no encontrado.' });
  }

  res.sendFile(target);
});

module.exports = router;
