'use strict';

/**
 * Determine a DMCA risk level based on ACRCloud confidence score.
 *
 * @param {number} score - Confidence score (0–100)
 * @returns {'HIGH'|'MEDIUM'|'LOW'|'UNKNOWN'} Risk level label
 */
function dmcaRiskLevel(score) {
  if (typeof score !== 'number' || isNaN(score)) return 'UNKNOWN';
  if (score >= 80) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

/**
 * Format seconds as HH:MM:SS string.
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

/**
 * Parse a raw ACRCloud identify response and return a structured array of
 * flagged music segments.
 *
 * @param {object} acrResponse     - Raw JSON response from ACRCloud
 * @param {number} [chunkStartSec] - Offset (seconds) of this chunk within the
 *                                   full VOD, so timestamps are absolute.
 * @returns {Array<{
 *   trackTitle: string,
 *   artist: string,
 *   album: string,
 *   timestampStart: string,
 *   timestampEnd: string,
 *   timestampStartSec: number,
 *   timestampEndSec: number,
 *   confidenceScore: number,
 *   dmcaRisk: string,
 *   acrid: string
 * }>} Array of flagged segments (empty if no match or error)
 */
function parseACRResponse(acrResponse, chunkStartSec = 0) {
  if (!acrResponse || typeof acrResponse !== 'object') {
    return [];
  }

  const status = acrResponse.status;
  if (!status || status.code !== 0) {
    // Non-zero codes: 1001 = no result, others = errors – return empty set
    return [];
  }

  const metadata = acrResponse.metadata;
  if (!metadata) return [];

  const musicList = Array.isArray(metadata.music) ? metadata.music : [];

  return musicList.map((track) => {
    const score = typeof track.score === 'number' ? track.score : 0;

    // Primary artist
    const artists = Array.isArray(track.artists)
      ? track.artists.map((a) => a.name).filter(Boolean).join(', ')
      : 'Unknown Artist';

    const album =
      track.album && track.album.name ? track.album.name : 'Unknown Album';

    // ACRCloud returns play_offset_ms: position of the recognised segment
    // within the audio sample.
    const offsetMs = typeof track.play_offset_ms === 'number' ? track.play_offset_ms : 0;
    const durationMs = typeof track.duration_ms === 'number' ? track.duration_ms : 0;

    const startSec = chunkStartSec + offsetMs / 1000;
    const endSec = durationMs > 0 ? startSec + durationMs / 1000 : startSec;

    return {
      trackTitle: track.title || 'Unknown Title',
      artist: artists,
      album,
      timestampStart: formatTimestamp(startSec),
      timestampEnd: formatTimestamp(endSec),
      timestampStartSec: Math.round(startSec * 100) / 100,
      timestampEndSec: Math.round(endSec * 100) / 100,
      confidenceScore: score,
      dmcaRisk: dmcaRiskLevel(score),
      acrid: track.acrid || '',
    };
  });
}

module.exports = { parseACRResponse, dmcaRiskLevel, formatTimestamp };
