'use strict';

const { parseACRResponse, dmcaRiskLevel, formatTimestamp } = require('../src/services/parser');

// ---------------------------------------------------------------------------
// dmcaRiskLevel
// ---------------------------------------------------------------------------
describe('dmcaRiskLevel', () => {
  test('returns HIGH for score >= 80', () => {
    expect(dmcaRiskLevel(80)).toBe('HIGH');
    expect(dmcaRiskLevel(95)).toBe('HIGH');
    expect(dmcaRiskLevel(100)).toBe('HIGH');
  });

  test('returns MEDIUM for score 50–79', () => {
    expect(dmcaRiskLevel(50)).toBe('MEDIUM');
    expect(dmcaRiskLevel(65)).toBe('MEDIUM');
    expect(dmcaRiskLevel(79)).toBe('MEDIUM');
  });

  test('returns LOW for score < 50', () => {
    expect(dmcaRiskLevel(0)).toBe('LOW');
    expect(dmcaRiskLevel(25)).toBe('LOW');
    expect(dmcaRiskLevel(49)).toBe('LOW');
  });

  test('returns UNKNOWN for non-numeric input', () => {
    expect(dmcaRiskLevel(NaN)).toBe('UNKNOWN');
    expect(dmcaRiskLevel(undefined)).toBe('UNKNOWN');
    expect(dmcaRiskLevel(null)).toBe('UNKNOWN');
    expect(dmcaRiskLevel('high')).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------
describe('formatTimestamp', () => {
  test('formats 0 seconds', () => {
    expect(formatTimestamp(0)).toBe('00:00:00');
  });

  test('formats seconds only', () => {
    expect(formatTimestamp(45)).toBe('00:00:45');
  });

  test('formats minutes and seconds', () => {
    expect(formatTimestamp(90)).toBe('00:01:30');
  });

  test('formats hours, minutes, seconds', () => {
    expect(formatTimestamp(3661)).toBe('01:01:01');
  });

  test('handles negative values gracefully (clamps to 0)', () => {
    expect(formatTimestamp(-5)).toBe('00:00:00');
  });

  test('handles fractional seconds by flooring', () => {
    expect(formatTimestamp(61.9)).toBe('00:01:01');
  });
});

// ---------------------------------------------------------------------------
// parseACRResponse
// ---------------------------------------------------------------------------
describe('parseACRResponse', () => {
  const buildResponse = (tracks) => ({
    status: { msg: 'Success', code: 0 },
    metadata: { music: tracks },
  });

  test('returns empty array for null input', () => {
    expect(parseACRResponse(null)).toEqual([]);
  });

  test('returns empty array for non-zero status code', () => {
    const response = { status: { msg: 'No result', code: 1001 } };
    expect(parseACRResponse(response)).toEqual([]);
  });

  test('returns empty array when metadata is missing', () => {
    const response = { status: { msg: 'Success', code: 0 } };
    expect(parseACRResponse(response)).toEqual([]);
  });

  test('returns empty array when music list is empty', () => {
    expect(parseACRResponse(buildResponse([]))).toEqual([]);
  });

  test('parses a single track correctly', () => {
    const tracks = [
      {
        title: 'Test Song',
        artists: [{ name: 'Test Artist' }],
        album: { name: 'Test Album' },
        score: 85,
        play_offset_ms: 5000,
        duration_ms: 210000,
        acrid: 'abc123',
      },
    ];
    const results = parseACRResponse(buildResponse(tracks));
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.trackTitle).toBe('Test Song');
    expect(r.artist).toBe('Test Artist');
    expect(r.album).toBe('Test Album');
    expect(r.confidenceScore).toBe(85);
    expect(r.dmcaRisk).toBe('HIGH');
    expect(r.acrid).toBe('abc123');
    expect(r.timestampStart).toBe('00:00:05');
    // startSec=5s + duration 210s = 215s = 3m35s
    expect(r.timestampEnd).toBe('00:03:35');
  });

  test('applies chunkStartSec offset to timestamps', () => {
    const tracks = [
      {
        title: 'Offset Song',
        artists: [{ name: 'Artist' }],
        score: 60,
        play_offset_ms: 0,
        duration_ms: 30000,
        acrid: 'xyz',
      },
    ];
    // chunk starts at 120 seconds into the VOD
    const results = parseACRResponse(buildResponse(tracks), 120);
    expect(results[0].timestampStart).toBe('00:02:00');
    expect(results[0].timestampStartSec).toBe(120);
    // endSec = startSec(120) + duration(30) = 150s = '00:02:30'
    expect(results[0].timestampEnd).toBe('00:02:30');
  });

  test('handles multiple artists joined with comma', () => {
    const tracks = [
      {
        title: 'Collab',
        artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
        score: 70,
        play_offset_ms: 0,
        duration_ms: 0,
        acrid: 'collab',
      },
    ];
    const results = parseACRResponse(buildResponse(tracks));
    expect(results[0].artist).toBe('Artist A, Artist B');
  });

  test('uses fallback values for missing fields', () => {
    const tracks = [
      {
        score: 30,
        play_offset_ms: 1000,
        duration_ms: 5000,
        acrid: 'min',
      },
    ];
    const results = parseACRResponse(buildResponse(tracks));
    expect(results[0].trackTitle).toBe('Unknown Title');
    expect(results[0].artist).toBe('Unknown Artist');
    expect(results[0].album).toBe('Unknown Album');
    expect(results[0].dmcaRisk).toBe('LOW');
  });

  test('parses multiple tracks', () => {
    const tracks = Array.from({ length: 3 }, (_, i) => ({
      title: `Track ${i}`,
      artists: [{ name: `Artist ${i}` }],
      score: i * 40,
      play_offset_ms: i * 10000,
      duration_ms: 30000,
      acrid: `acrid_${i}`,
    }));
    const results = parseACRResponse(buildResponse(tracks));
    expect(results).toHaveLength(3);
  });
});
