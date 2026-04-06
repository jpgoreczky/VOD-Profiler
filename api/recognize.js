'use strict';

/**
 * /api/recognize  – Audio recognition endpoint.
 *
 * Supports two modes:
 *
 * 1. File upload (multipart/form-data):
 *      audio    – audio file (mp3, wav, aac, etc., ≤ 4 MB)
 *      startSec – optional offset (seconds) to apply to returned timestamps
 *
 * 2. URL scan (application/json):
 *      url      – publicly accessible audio/video URL to fetch and scan
 *      startSec – optional offset (seconds) to apply to returned timestamps
 *
 * Response (JSON):
 *   { results: [...] }   – array of flagged segments (may be empty if no match)
 *   { error: '...' }     – on validation / processing failure
 */

require('dotenv').config();

const dns = require('dns').promises;
const axios = require('axios');
const multer = require('multer');
const { recognizeAudio } = require('../src/services/acrcloud');
const { parseACRResponse } = require('../src/services/parser');
const { isYouTubeUrl, extractYouTubeAudio } = require('../src/services/youtube');

const MAX_FETCH_BYTES = parseInt(process.env.MAX_CHUNK_SIZE || '4194304', 10);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FETCH_BYTES,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the raw JSON body from an HTTP request.
 *
 * Works in both Express (streaming body) and Vercel pre-buffered contexts:
 * if req.body is already an object (set by express.json() middleware), it is
 * returned directly; otherwise the stream is read manually.
 */
function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const MAX_BODY = 4096;
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Return true when an IP address string falls in a private or reserved range.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '0.0.0.0' ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^(fc|fd)[0-9a-f]{2}:/i.test(ip)
  );
}

/**
 * Return true when a hostname string looks like a private/local address.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^(::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(hostname)
  );
}

/**
 * SSRF guard: resolve the hostname to its IP and verify it is not a private
 * or reserved address.
 *
 * Two-layer check:
 *   1. Hostname-pattern check (fast path for obvious cases).
 *   2. DNS resolution + IP-range check to catch domains that point at private
 *      IPs – this significantly raises the bar for DNS-rebinding attacks.
 *
 * Note: A residual TOCTOU window exists between this check and the actual HTTP
 * request if an attacker controls DNS TTLs.  Full elimination requires
 * intercepting the TCP connection (e.g. a custom http.Agent that validates the
 * socket's remote address), which is beyond the scope of this implementation.
 *
 * @param {URL} parsedUrl
 * @returns {Promise<boolean>} true when the URL should be blocked
 */
async function isPrivateOrLocalUrl(parsedUrl) {
  const h = parsedUrl.hostname;

  if (isPrivateHostname(h)) return true;

  try {
    const { address } = await dns.lookup(h);
    return isPrivateIp(address);
  } catch {
    // DNS lookup failed → block for safety
    return true;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();

  // ---------------------------------------------------------------------------
  // URL-based scan: JSON body with { url, startSec? }
  // ---------------------------------------------------------------------------
  if (contentType.includes('application/json')) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { url, startSec } = body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "url" field' });
    }

    // Validate URL format and protocol first (applies to all URL types)
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http and https URLs are allowed' });
    }

    const startSecNum = startSec !== undefined ? parseFloat(startSec) : 0;
    if (isNaN(startSecNum)) {
      return res.status(400).json({ error: 'Invalid startSec value' });
    }

    // ---------------------------------------------------------------------------
    // YouTube URL – extract audio-only stream via @distube/ytdl-core.
    // Checked before the SSRF guard: youtube.com is always a public address and
    // the audio is fetched through ytdl rather than a raw axios request.
    // ---------------------------------------------------------------------------
    if (isYouTubeUrl(url)) {
      let audioBuffer;
      let audioFilename;
      try {
        ({ buffer: audioBuffer, filename: audioFilename } = await extractYouTubeAudio(url));
      } catch (err) {
        // COOKIE_MISSING → 503 Service Unavailable (server misconfiguration)
        // COOKIE_EXPIRED → 503 Service Unavailable (credentials need refresh)
        // Other ytdl errors → 502 Bad Gateway
        const status = err.code === 'COOKIE_MISSING' || err.code === 'COOKIE_EXPIRED' ? 503 : 502;
        return res.status(status).json({ error: err.message });
      }

      try {
        const acrResponse = await recognizeAudio(audioBuffer, audioFilename);
        const results = parseACRResponse(acrResponse, startSecNum);
        return res.status(200).json({ results });
      } catch (err) {
        const status = err.message.includes('credentials') ? 503 : 502;
        return res.status(status).json({ error: err.message });
      }
    }

    // ---------------------------------------------------------------------------
    // Generic direct URL – SSRF check then fetch via axios.
    // ---------------------------------------------------------------------------
    if (await isPrivateOrLocalUrl(parsedUrl)) {
      return res.status(400).json({ error: 'Requests to private or local addresses are not allowed' });
    }

    // Fetch the audio from the URL (with size limit to prevent OOM)
    let audioBuffer;
    try {
      const fetchResponse = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: MAX_FETCH_BYTES,
        maxBodyLength: MAX_FETCH_BYTES,
      });
      audioBuffer = Buffer.from(fetchResponse.data);
    } catch (fetchErr) {
      if (fetchErr.response) {
        return res.status(502).json({ error: `Failed to fetch URL (HTTP ${fetchErr.response.status})` });
      }
      return res.status(502).json({ error: `Failed to fetch URL: ${fetchErr.message}` });
    }

    const audioFilename = parsedUrl.pathname.split('/').pop() || 'audio.mp3';
    try {
      const acrResponse = await recognizeAudio(audioBuffer, audioFilename);
      const results = parseACRResponse(acrResponse, startSecNum);
      return res.status(200).json({ results });
    } catch (err) {
      const status = err.message.includes('credentials') ? 503 : 502;
      return res.status(status).json({ error: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // File-based scan: multipart/form-data with "audio" field
  // ---------------------------------------------------------------------------

  // Wrap in try/catch so a multer error (e.g. file too large) returns 400
  // instead of crashing with an unhandled promise rejection.
  try {
    await new Promise((resolve, reject) => {
      upload.single('audio')(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

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
