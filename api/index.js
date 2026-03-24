'use strict';

/**
 * api/index.js – Local development Express server.
 *
 * This file is NOT deployed to Vercel (Vercel uses api/upload.js and
 * api/recognize.js directly as serverless functions). It exists purely for
 * local `npm start` / `npm run dev` convenience.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const uploadHandler = require('./upload');
const recognizeHandler = require('./recognize');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limit API routes (100 req / 15 min per IP)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Serve the static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Mount API handlers
app.post('/api/upload', apiLimiter, uploadHandler);
app.post('/api/recognize', apiLimiter, recognizeHandler);

// Fallback to index.html for SPA-style navigation
app.get('*', rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }), (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`VOD-Profiler dev server running at http://localhost:${PORT}`);
});

module.exports = app;
