'use strict';

/**
 * /api/upload  – Chunked file upload endpoint.
 *
 * Clients split large video/audio files into chunks and POST each chunk
 * individually.  Because Vercel serverless functions have a 4.5 MB request
 * payload limit, each chunk must be ≤ 4 MB.
 *
 * Request (multipart/form-data):
 *   chunk         – binary chunk data (required)
 *   uploadId      – unique session identifier (required, alphanumeric/dash/underscore)
 *   chunkIndex    – 0-based index of this chunk (required)
 *   totalChunks   – total number of chunks in this upload (required, max 500)
 *   filename      – original filename (sent with every chunk)
 *   totalDuration – total duration of the media in seconds (optional, sent with every chunk)
 *
 * Response (JSON):
 *   { received: true, chunkIndex, uploadId }     – chunk accepted, more expected
 *   { done: true, uploadId, results: [...] }      – final chunk processed
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { recognizeAudio } = require('../src/services/acrcloud');
const { parseACRResponse } = require('../src/services/parser');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// uploadId must be alphanumeric + dash/underscore, max 64 chars.
// This prevents path-traversal attacks when the value is used in path.join().
const UPLOAD_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

// Guard against DoS – 500 × 4 MB ≈ 2 GB max upload
const MAX_TOTAL_CHUNKS = 500;

// Run up to 3 ACRCloud requests concurrently to reduce overall latency while
// staying within ACRCloud's per-second rate limits.
const CONCURRENCY_LIMIT = 3;

// ---------------------------------------------------------------------------
// Multer: store each chunk in memory (chunks are ≤ 4 MB by design)
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_CHUNK_SIZE || '4194304', 10),
  },
});

// ---------------------------------------------------------------------------
// Async filesystem helpers
// (non-blocking equivalents of the sync calls to avoid stalling the event loop)
// ---------------------------------------------------------------------------

async function getTmpDir(uploadId) {
  const dir = path.join(os.tmpdir(), 'vod-profiler', uploadId);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function saveChunk(uploadId, chunkIndex, buffer) {
  const dir = await getTmpDir(uploadId);
  const chunkPath = path.join(dir, `chunk_${String(chunkIndex).padStart(5, '0')}`);
  await fs.promises.writeFile(chunkPath, buffer);
  return chunkPath;
}

/**
 * Count received chunk files via the filesystem.
 *
 * Using the filesystem for completion tracking means the count is accurate
 * even when consecutive requests land on different Vercel lambda instances
 * (each instance shares the same /tmp filesystem within a deployment).
 * An in-process Map would reset to zero on a cold instance and miscount.
 */
async function countReceivedChunks(uploadId) {
  const dir = path.join(os.tmpdir(), 'vod-profiler', uploadId);
  try {
    const files = await fs.promises.readdir(dir);
    return files.filter((f) => f.startsWith('chunk_')).length;
  } catch {
    return 0; // Directory does not exist yet
  }
}

async function cleanupUpload(uploadId) {
  const dir = path.join(os.tmpdir(), 'vod-profiler', uploadId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Parse the multipart form – wrap in try/catch so a multer error (e.g. file
  // too large) is returned as a 400 rather than crashing with an unhandled
  // promise rejection.
  try {
    await new Promise((resolve, reject) => {
      upload.single('chunk')(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

  const { uploadId, chunkIndex: rawChunkIndex, totalChunks: rawTotalChunks, filename, totalDuration } = req.body;

  // Validate uploadId strictly to prevent path-traversal: the value is used
  // directly in path.join() to build the /tmp directory path.
  if (!uploadId || !UPLOAD_ID_REGEX.test(uploadId)) {
    return res.status(400).json({
      error: 'Invalid uploadId. Must be 1–64 characters: letters, numbers, hyphens, or underscores.',
    });
  }

  if (rawChunkIndex === undefined || rawTotalChunks === undefined) {
    return res.status(400).json({ error: 'Missing required fields: chunkIndex, totalChunks' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No chunk data received' });
  }

  const chunkIndex = parseInt(rawChunkIndex, 10);
  const totalChunks = parseInt(rawTotalChunks, 10);

  if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || totalChunks < 1) {
    return res.status(400).json({ error: 'Invalid chunkIndex or totalChunks' });
  }
  if (chunkIndex >= totalChunks) {
    return res.status(400).json({ error: 'chunkIndex must be less than totalChunks' });
  }
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    return res.status(400).json({ error: `totalChunks exceeds maximum of ${MAX_TOTAL_CHUNKS}` });
  }

  // Persist this chunk to /tmp
  try {
    await saveChunk(uploadId, chunkIndex, req.file.buffer);
  } catch (err) {
    return res.status(500).json({ error: `Failed to save chunk: ${err.message}` });
  }

  // Count received chunks via the filesystem (see countReceivedChunks comment above)
  const receivedCount = await countReceivedChunks(uploadId);

  if (receivedCount < totalChunks) {
    return res.status(200).json({
      received: true,
      chunkIndex,
      uploadId,
      progress: `${receivedCount}/${totalChunks}`,
    });
  }

  // All chunks received – process each chunk file directly against ACRCloud.
  //
  // Previous approach loaded ALL chunks into a single Buffer.concat() then
  // split the result into 1 MB segments, holding the entire file in RAM twice
  // transiently. Instead, we read and submit one chunk at a time (each ≤ 4 MB)
  // in batches, so peak RAM stays at CONCURRENCY_LIMIT × MAX_CHUNK_SIZE.
  const safeFilename = filename || 'upload.mp4';
  const totalDurationSec = totalDuration ? parseFloat(totalDuration) : 0;
  const tmpDir = path.join(os.tmpdir(), 'vod-profiler', uploadId);

  const allResults = [];
  const errors = [];

  for (let batchStart = 0; batchStart < totalChunks; batchStart += CONCURRENCY_LIMIT) {
    const batchEnd = Math.min(batchStart + CONCURRENCY_LIMIT, totalChunks);
    const batchPromises = [];

    for (let ci = batchStart; ci < batchEnd; ci++) {
      const chunkIdx = ci;
      const chunkPath = path.join(tmpDir, `chunk_${String(chunkIdx).padStart(5, '0')}`);
      const chunkStartSec = totalDurationSec > 0 ? (chunkIdx / totalChunks) * totalDurationSec : 0;

      batchPromises.push(
        fs.promises
          .readFile(chunkPath)
          .then((buf) => recognizeAudio(buf, safeFilename))
          .then((acrResponse) => parseACRResponse(acrResponse, chunkStartSec))
          .catch((err) => ({ _error: err.message, segment: chunkIdx, _fatal: err.code === 'ENOENT' }))
      );
    }

    const batchResults = await Promise.all(batchPromises);
    for (const result of batchResults) {
      if (result && result._error !== undefined) {
        if (result._fatal) {
          // A chunk file is missing – indicates data corruption or a race condition.
          // Fail fast with a clear error rather than returning incomplete results.
          await cleanupUpload(uploadId);
          return res.status(500).json({
            error: `Missing chunk file for segment ${result.segment}. The upload may be incomplete or corrupted.`,
          });
        }
        errors.push({ segment: result.segment, error: result._error });
      } else {
        allResults.push(...result);
      }
    }
  }

  // Deduplicate by acrid + approximate timestamp
  const seen = new Set();
  const deduplicated = allResults.filter((r) => {
    const key = `${r.acrid}|${r.timestampStartSec}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await cleanupUpload(uploadId);

  return res.status(200).json({
    done: true,
    uploadId,
    results: deduplicated,
    errors: errors.length > 0 ? errors : undefined,
  });
}

module.exports = handler;
