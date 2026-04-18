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
// Cookie parsing
// ---------------------------------------------------------------------------

/**
 * Parse a browser/Netscape cookie header string into the object array format
 * expected by ytdl.createAgent().
 *
 * Input:  "name1=value1; name2=value2; ..."
 * Output: [{ name, value, domain, path, secure, httpOnly }, ...]
 *
 * All cookies are scoped to .youtube.com as required by the library.
 *
 * @param {string} cookieStr - Semicolon-delimited name=value pairs.
 * @returns {{ name: string, value: string, domain: string, path: string, secure: boolean, httpOnly: boolean }[]}
 */
function parseCookieString(cookieStr) {
  if (!cookieStr || typeof cookieStr !== 'string') return [];

  return cookieStr
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) return null;
      return {
        name: part.slice(0, eqIdx).trim(),
        value: part.slice(eqIdx + 1).trim(),
        domain: '.youtube.com',
        path: '/',
        secure: true,
        httpOnly: false,
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Agent creation
// ---------------------------------------------------------------------------

/**
 * Create a ytdl request agent pre-loaded with the YouTube session cookies from
 * the YOUTUBE_COOKIE environment variable.
 *
 * Returns `{ agent, cookieMissing: false }` on success.
 * Returns `{ agent: null, cookieMissing: true }` when YOUTUBE_COOKIE is unset.
 *
 * @returns {{ agent: object|null, cookieMissing: boolean }}
 */
function buildYtdlAgent() {
  const cookieStr = process.env.YOUTUBE_COOKIE;
  if (!cookieStr) {
    return { agent: null, cookieMissing: true };
  }
  const cookies = parseCookieString(cookieStr);
  const agent = ytdl.createAgent(cookies);
  return { agent, cookieMissing: false };
}

// ---------------------------------------------------------------------------
// Audio extraction
// ---------------------------------------------------------------------------

/**
 * Buffer the first `maxBytes` of the lowest-bitrate audio-only stream from a
 * YouTube video URL and return the raw audio bytes.
 *
 * Authentication:
 *  YouTube blocks requests from datacenter IPs unless a valid session cookie is
 *  provided.  The cookie string must be set in the YOUTUBE_COOKIE environment
 *  variable (semicolon-delimited name=value pairs copied from a logged-in
 *  YouTube browser session).  If the variable is absent, the function rejects
 *  immediately with a COOKIE_MISSING error code so the caller can return an
 *  actionable 503 to the client.  If the cookies are present but expired or
 *  otherwise rejected by YouTube (manifesting as "Sign in to confirm" or HTTP
 *  429 stream errors), a COOKIE_EXPIRED error code is used instead.
 *
 * Design decisions:
 *  - `filter: 'audioonly'`    – request only the audio track; no video data.
 *  - `quality: 'lowestaudio'` – pick the smallest/most-compressed format to
 *    minimise bytes-per-second, keeping us well inside the Vercel 60 s limit.
 *  - `highWaterMark: 64 KB`   – small internal read buffer so data events fire
 *    frequently and the byte cap is enforced tightly.
 *  - Stream is destroyed as soon as we reach `maxBytes` or an error/timeout
 *    fires; this ensures no further YouTube data is fetched after we stop.
 *  - The 1 MB default cap corresponds to ~30–90 s of heavily-compressed audio
 *    at 64–128 kbps – more than enough for ACRCloud fingerprinting (~10 s).
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
 * @throws {Error} When the env var is missing (err.code === 'COOKIE_MISSING'),
 *   cookies are expired/blocked (err.code === 'COOKIE_EXPIRED'), the stream
 *   errors, or the extraction times out.
 */
function extractYouTubeAudio(url, { maxBytes = 1 * 1024 * 1024, timeoutMs = 50000 } = {}) {
  // Reject early if the session cookie env var is not configured.
  const { agent, cookieMissing } = buildYtdlAgent();
  if (cookieMissing) {
    const err = new Error(
      'YOUTUBE_COOKIE environment variable is not set. ' +
        'Copy your YouTube session cookies from a logged-in browser into this ' +
        'variable (semicolon-delimited name=value pairs) to enable YouTube scanning.'
    );
    err.code = 'COOKIE_MISSING';
    return Promise.reject(err);
  }

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
      settle(
        new Error(
          'YouTube audio extraction timed out. The video may be too large or the network too slow.'
        )
      );
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
        agent,
      });
    } catch (initErr) {
      clearTimeout(timer);
      return reject(new Error(`Failed to initialise YouTube stream: ${initErr.message}`));
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

    stream.on('error', (streamErr) => {
      const msg = streamErr.message || '';
      // Detect YouTube's bot-check / session-expired responses so the caller
      // can surface a targeted error to the user instead of a generic 502.
      const isCookieError =
        /sign.?in/i.test(msg) ||
        /confirm.*not.*bot/i.test(msg) ||
        /status code: 4(29|03)/i.test(msg);

      if (isCookieError) {
        const expiredErr = new Error(
          'YouTube rejected the request (bot check or session expired). ' +
            'Please update the YOUTUBE_COOKIE environment variable with fresh ' +
            'cookies from a logged-in YouTube browser session.'
        );
        expiredErr.code = 'COOKIE_EXPIRED';
        settle(expiredErr);
      } else {
        settle(new Error(`YouTube stream error: ${streamErr.message}`));
      }
    });
  });
}

module.exports = { isYouTubeUrl, parseCookieString, buildYtdlAgent, extractYouTubeAudio };
