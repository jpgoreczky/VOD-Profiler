'use strict';

const ytdl = require('@distube/ytdl-core');

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/**
 * Patterns that identify YouTube video URLs.
 *
 * Matches:
 *   https://www.youtube.com/watch?v=XXXXXXXXXXX
 *   https://youtube.com/watch?v=XXXXXXXXXXX
 *   https://youtu.be/XXXXXXXXXXX
 *   https://www.youtube.com/shorts/XXXXXXXXXXX
 *   https://m.youtube.com/watch?v=XXXXXXXXXXX
 */
const YOUTUBE_URL_REGEX =
  /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/)/i;

/**
 * @param {string} url
 * @returns {boolean}
 */
function isYouTubeUrl(url) {
  if (typeof url !== 'string') return false;
  return YOUTUBE_URL_REGEX.test(url);
}

// ---------------------------------------------------------------------------
// Audio extraction
// ---------------------------------------------------------------------------

/**
 * Buffer the first `maxBytes` of the lowest-bitrate audio-only stream from a
 * YouTube video URL and return the raw audio bytes.
 *
 * Design decisions:
 *  - `filter: 'audioonly'`   – request only the audio track; no video data.
 *  - `quality: 'lowestaudio'` – pick the smallest/most-compressed format to
 *    minimise bytes-per-second, keeping us well inside the Vercel 60 s limit.
 *  - `highWaterMark: 64 KB`  – small internal read buffer so data events fire
 *    frequently and the byte cap is enforced tightly.
 *  - Stream is destroyed as soon as we reach `maxBytes` or an error/timeout
 *    fires; this ensures no further YouTube data is fetched after we stop.
 *  - The 1 MB default cap corresponds to ~30–90 s of heavily-compressed audio
 *    at 64–128 kbps – more than enough for ACRCloud fingerprinting (which
 *    needs ~10 s).
 *
 * @param {string} url - YouTube video URL
 * @param {object} [options]
 * @param {number} [options.maxBytes=1048576] - Max bytes to buffer before
 *   stopping the stream.  Default: 1 MB.
 * @param {number} [options.timeoutMs=50000] - Hard timeout for the entire
 *   extraction.  Default: 50 s — leaves ~10 s for the subsequent ACRCloud API
 *   call (typically 2–5 s) plus response serialisation, well within Vercel's
 *   60 s function limit.
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 * @throws {Error} When the stream errors, times out, or YouTube rejects the request.
 */
function extractYouTubeAudio(url, { maxBytes = 1 * 1024 * 1024, timeoutMs = 50000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let stream;

    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Destroy the underlying stream to release the network connection.
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      settle(new Error('YouTube audio extraction timed out. The video may be too large or the network too slow.'));
    }, timeoutMs);

    // Validate URL upfront to surface errors before attempting a network request.
    if (!ytdl.validateURL(url)) {
      clearTimeout(timer);
      return reject(new Error('Invalid or unsupported YouTube URL.'));
    }

    try {
      stream = ytdl(url, {
        filter: 'audioonly',
        quality: 'lowestaudio',
        highWaterMark: 64 * 1024, // 64 KB internal read buffer
      });
    } catch (err) {
      clearTimeout(timer);
      return reject(new Error(`Failed to initialise YouTube stream: ${err.message}`));
    }

    stream.on('data', (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;

      if (totalBytes >= maxBytes) {
        // We have collected enough audio for fingerprinting – stop the download.
        settle(null, {
          buffer: Buffer.concat(chunks),
          filename: 'youtube-audio.mp4',
        });
      }
    });

    stream.on('end', () => {
      settle(null, {
        buffer: Buffer.concat(chunks),
        filename: 'youtube-audio.mp4',
      });
    });

    stream.on('error', (err) => {
      settle(new Error(`YouTube stream error: ${err.message}`));
    });
  });
}

module.exports = { isYouTubeUrl, extractYouTubeAudio };
