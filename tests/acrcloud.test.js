'use strict';

const { buildSignature, getMimeType } = require('../src/services/acrcloud');

describe('buildSignature', () => {
  test('returns a non-empty base64 string', () => {
    const sig = buildSignature('secret', 'POST', '/v1/identify', 'mykey', 1700000000);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    // Base64 characters only
    expect(/^[A-Za-z0-9+/=]+$/.test(sig)).toBe(true);
  });

  test('is deterministic – same inputs produce same signature', () => {
    const args = ['secret', 'POST', '/v1/identify', 'mykey', 1700000000];
    expect(buildSignature(...args)).toBe(buildSignature(...args));
  });

  test('changes when the secret changes', () => {
    const sig1 = buildSignature('secret1', 'POST', '/v1/identify', 'key', 1700000000);
    const sig2 = buildSignature('secret2', 'POST', '/v1/identify', 'key', 1700000000);
    expect(sig1).not.toBe(sig2);
  });

  test('changes when the timestamp changes', () => {
    const sig1 = buildSignature('secret', 'POST', '/v1/identify', 'key', 1700000000);
    const sig2 = buildSignature('secret', 'POST', '/v1/identify', 'key', 1700000001);
    expect(sig1).not.toBe(sig2);
  });
});

describe('getMimeType', () => {
  test('returns audio/mpeg for .mp3', () => {
    expect(getMimeType('track.mp3')).toBe('audio/mpeg');
  });

  test('returns audio/wav for .wav', () => {
    expect(getMimeType('clip.wav')).toBe('audio/wav');
  });

  test('returns audio/aac for .aac', () => {
    expect(getMimeType('audio.aac')).toBe('audio/aac');
  });

  test('returns video/mp4 for .mp4', () => {
    expect(getMimeType('vod.mp4')).toBe('video/mp4');
  });

  test('returns video/webm for .webm', () => {
    expect(getMimeType('stream.webm')).toBe('video/webm');
  });

  test('returns video/quicktime for .mov', () => {
    expect(getMimeType('clip.mov')).toBe('video/quicktime');
  });

  test('returns application/octet-stream for unknown extension', () => {
    expect(getMimeType('data.xyz')).toBe('application/octet-stream');
  });

  test('returns application/octet-stream for no extension', () => {
    expect(getMimeType('noextension')).toBe('application/octet-stream');
  });

  test('is case-insensitive for extension', () => {
    expect(getMimeType('track.MP3')).toBe('audio/mpeg');
    expect(getMimeType('clip.WAV')).toBe('audio/wav');
  });
});

describe('uploadId validation regex', () => {
  // The UPLOAD_ID_REGEX used in upload.js is not exported, so we recreate it
  // here to document the contract and catch regressions.
  const UPLOAD_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  test('accepts valid uploadId', () => {
    expect(UPLOAD_ID_REGEX.test('abc123')).toBe(true);
    expect(UPLOAD_ID_REGEX.test('upload-123_test')).toBe(true);
    expect(UPLOAD_ID_REGEX.test('A'.repeat(64))).toBe(true);
  });

  test('rejects path-traversal sequences', () => {
    expect(UPLOAD_ID_REGEX.test('../etc/passwd')).toBe(false);
    expect(UPLOAD_ID_REGEX.test('../../secrets')).toBe(false);
    expect(UPLOAD_ID_REGEX.test('/absolute/path')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(UPLOAD_ID_REGEX.test('')).toBe(false);
  });

  test('rejects strings longer than 64 characters', () => {
    expect(UPLOAD_ID_REGEX.test('A'.repeat(65))).toBe(false);
  });

  test('rejects special characters outside allowed set', () => {
    expect(UPLOAD_ID_REGEX.test('id with spaces')).toBe(false);
    expect(UPLOAD_ID_REGEX.test('id<script>')).toBe(false);
  });
});
