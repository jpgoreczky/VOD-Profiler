'use strict';

const { buildSignature } = require('../src/services/acrcloud');

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
