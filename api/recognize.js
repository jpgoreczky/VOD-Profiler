'use strict';

/**
 * /api/recognize  – Single-shot audio recognition endpoint.
 *
 * Use this endpoint to identify music in a small audio clip (≤ 4 MB) without
 * chunking.  The client sends the audio as a multipart/form-data file upload.
 *
 * Request (multipart/form-data):
 *   audio      – audio file (mp3, wav, aac, etc., ≤ 4 MB)
 *   startSec   – optional offset (seconds) to apply to returned timestamps
 *
 * Response (JSON):
 *   { results: [...] }   – array of flagged segments (may be empty if no match)
 *   { error: '...' }     – on validation / processing failure
 */

require('dotenv').config();

const multer = require('multer');
const { recognizeAudio } = require('../src/services/acrcloud');
const { parseACRResponse } = require('../src/services/parser');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_CHUNK_SIZE || '4194304', 10),
  },
});

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Parse the multipart form
  await new Promise((resolve, reject) => {
    upload.single('audio')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received. Send an "audio" field in multipart/form-data.' });
  }

  const startSec = req.body.startSec ? parseFloat(req.body.startSec) : 0;
  if (isNaN(startSec)) {
    return res.status(400).json({ error: 'Invalid startSec value' });
  }

  try {
    const acrResponse = await recognizeAudio(req.file.buffer, req.file.originalname || 'audio.mp3');
    const results = parseACRResponse(acrResponse, startSec);
    return res.status(200).json({ results });
  } catch (err) {
    const status = err.message.includes('credentials') ? 503 : 502;
    return res.status(status).json({ error: err.message });
  }
}

module.exports = handler;
