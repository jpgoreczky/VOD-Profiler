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
 *   uploadId      – unique session identifier (required)
 *   chunkIndex    – 0-based index of this chunk (required)
 *   totalChunks   – total number of chunks in this upload (required)
 *   filename      – original filename (required on chunk 0)
 *   totalDuration – total duration of the media in seconds (optional, used for
 *                   calculating per-chunk time offsets)
 *
 * Response (JSON):
 *   { received: true, chunkIndex, uploadId }          – chunk accepted
 *   { done: true, uploadId, results: [...] }           – last chunk processed,
 *                                                        returns all ACRCloud
 *                                                        results
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { recognizeAudio } = require('../src/services/acrcloud');
const { parseACRResponse } = require('../src/services/parser');

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
// In-process chunk registry
// NOTE: On Vercel each request may land on a different lambda instance, so
// for a production deployment you would replace this with an external store
// (e.g. Vercel KV / Redis / S3).  For local dev and single-instance setups
// the in-process map works correctly.
// ---------------------------------------------------------------------------
const chunkRegistry = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTmpDir(uploadId) {
  const dir = path.join(os.tmpdir(), 'vod-profiler', uploadId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveChunk(uploadId, chunkIndex, buffer) {
  const dir = getTmpDir(uploadId);
  const chunkPath = path.join(dir, `chunk_${String(chunkIndex).padStart(5, '0')}`);
  fs.writeFileSync(chunkPath, buffer);
  return chunkPath;
}

function loadAllChunks(uploadId, totalChunks) {
  const dir = getTmpDir(uploadId);
  const buffers = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(dir, `chunk_${String(i).padStart(5, '0')}`);
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
    }
    buffers.push(fs.readFileSync(chunkPath));
  }
  return Buffer.concat(buffers);
}

function cleanupUpload(uploadId) {
  const dir = path.join(os.tmpdir(), 'vod-profiler', uploadId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  chunkRegistry.delete(uploadId);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Parse the multipart form
  await new Promise((resolve, reject) => {
    upload.single('chunk')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const { uploadId, chunkIndex: rawChunkIndex, totalChunks: rawTotalChunks, filename, totalDuration } = req.body;

  // Validate required fields
  if (!uploadId || rawChunkIndex === undefined || rawTotalChunks === undefined) {
    return res.status(400).json({ error: 'Missing required fields: uploadId, chunkIndex, totalChunks' });
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

  // Persist this chunk to /tmp
  try {
    saveChunk(uploadId, chunkIndex, req.file.buffer);
  } catch (err) {
    return res.status(500).json({ error: `Failed to save chunk: ${err.message}` });
  }

  // Track received chunks
  if (!chunkRegistry.has(uploadId)) {
    chunkRegistry.set(uploadId, {
      received: new Set(),
      totalChunks,
      filename: filename || 'upload.mp4',
      totalDuration: totalDuration ? parseFloat(totalDuration) : null,
    });
  }
  const session = chunkRegistry.get(uploadId);
  session.received.add(chunkIndex);

  // If not all chunks have arrived yet, acknowledge and wait
  if (session.received.size < totalChunks) {
    return res.status(200).json({
      received: true,
      chunkIndex,
      uploadId,
      progress: `${session.received.size}/${totalChunks}`,
    });
  }

  // All chunks received – assemble and process
  let assembledBuffer;
  try {
    assembledBuffer = loadAllChunks(uploadId, totalChunks);
  } catch (err) {
    cleanupUpload(uploadId);
    return res.status(500).json({ error: `Failed to assemble chunks: ${err.message}` });
  }

  // Split the assembled buffer into ACRCloud-friendly segments (≤ 60 s each).
  // We approximate audio duration from file size assuming ~128 kbps.
  const totalDurationSec = session.totalDuration || (assembledBuffer.length / (128 * 1024 / 8));
  const segmentSize = 1 * 1024 * 1024; // 1 MB per ACRCloud request segment
  const segments = [];
  for (let offset = 0; offset < assembledBuffer.length; offset += segmentSize) {
    segments.push(assembledBuffer.slice(offset, offset + segmentSize));
  }

  const allResults = [];
  const errors = [];

  for (let i = 0; i < segments.length; i++) {
    const segmentBuffer = segments[i];
    const chunkStartSec = (i / segments.length) * totalDurationSec;
    try {
      const acrResponse = await recognizeAudio(segmentBuffer, session.filename);
      const parsed = parseACRResponse(acrResponse, chunkStartSec);
      allResults.push(...parsed);
    } catch (err) {
      errors.push({ segment: i, error: err.message });
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

  cleanupUpload(uploadId);

  return res.status(200).json({
    done: true,
    uploadId,
    results: deduplicated,
    errors: errors.length > 0 ? errors : undefined,
  });
}

module.exports = handler;
