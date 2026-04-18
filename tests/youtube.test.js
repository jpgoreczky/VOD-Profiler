'use strict';

const { isYouTubeUrl, parseCookieString, buildYtdlAgent } = require('../src/services/youtube');

// ---------------------------------------------------------------------------
// isYouTubeUrl
// ---------------------------------------------------------------------------
describe('isYouTubeUrl', () => {
  // Positive cases
  test('matches standard watch URL', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  test('matches youtube.com without www', () => {
    expect(isYouTubeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  test('matches mobile youtube.com URL', () => {
    expect(isYouTubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  test('matches youtu.be short URL', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  test('matches YouTube Shorts URL', () => {
    expect(isYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
  });

  test('matches watch URL with extra query params', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLxxx')).toBe(true);
  });

  // Negative cases
  test('rejects plain audio file URL', () => {
    expect(isYouTubeUrl('https://example.com/audio.mp3')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isYouTubeUrl('')).toBe(false);
  });

  test('rejects non-string input', () => {
    expect(isYouTubeUrl(null)).toBe(false);
    expect(isYouTubeUrl(undefined)).toBe(false);
    expect(isYouTubeUrl(42)).toBe(false);
  });

  test('rejects Twitch VOD URL', () => {
    expect(isYouTubeUrl('https://www.twitch.tv/videos/123456789')).toBe(false);
  });

  test('rejects a URL that contains "youtube" in the path but is not YouTube', () => {
    expect(isYouTubeUrl('https://example.com/youtube/watch?v=abc')).toBe(false);
  });

  test('matches http YouTube URL', () => {
    expect(isYouTubeUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCookieString
// ---------------------------------------------------------------------------
describe('parseCookieString', () => {
  test('parses a single name=value pair', () => {
    const result = parseCookieString('SESSION_ID=abc123');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'SESSION_ID', value: 'abc123' });
  });

  test('parses multiple name=value pairs separated by semicolons', () => {
    const result = parseCookieString('VISITOR_INFO=xyz; YSC=foo; SAPISID=bar');
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ name: 'VISITOR_INFO', value: 'xyz' });
    expect(result[1]).toMatchObject({ name: 'YSC', value: 'foo' });
    expect(result[2]).toMatchObject({ name: 'SAPISID', value: 'bar' });
  });

  test('scopes all cookies to .youtube.com', () => {
    const result = parseCookieString('A=1; B=2');
    result.forEach((c) => {
      expect(c.domain).toBe('.youtube.com');
      expect(c.path).toBe('/');
      expect(c.secure).toBe(true);
    });
  });

  test('handles values that contain = signs', () => {
    const result = parseCookieString('TOKEN=abc=def==');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'TOKEN', value: 'abc=def==' });
  });

  test('ignores entries without an = sign', () => {
    const result = parseCookieString('GOOD=ok; BADTOKEN; ANOTHER=yes');
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name)).toEqual(['GOOD', 'ANOTHER']);
  });

  test('trims whitespace around names and values', () => {
    const result = parseCookieString('  NAME  =  value  ');
    expect(result[0].name).toBe('NAME');
    expect(result[0].value).toBe('value');
  });

  test('returns empty array for empty string', () => {
    expect(parseCookieString('')).toEqual([]);
  });

  test('returns empty array for null/undefined', () => {
    expect(parseCookieString(null)).toEqual([]);
    expect(parseCookieString(undefined)).toEqual([]);
  });

  test('returns empty array for non-string input', () => {
    expect(parseCookieString(42)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildYtdlAgent
// ---------------------------------------------------------------------------
describe('buildYtdlAgent', () => {
  const originalEnv = process.env.YOUTUBE_COOKIE;

  afterEach(() => {
    // Restore the env var after each test.
    if (originalEnv === undefined) {
      delete process.env.YOUTUBE_COOKIE;
    } else {
      process.env.YOUTUBE_COOKIE = originalEnv;
    }
  });

  test('returns cookieMissing=true when YOUTUBE_COOKIE is not set', () => {
    delete process.env.YOUTUBE_COOKIE;
    const { agent, cookieMissing } = buildYtdlAgent();
    expect(cookieMissing).toBe(true);
    expect(agent).toBeNull();
  });

  test('returns cookieMissing=false and a non-null agent when YOUTUBE_COOKIE is set', () => {
    process.env.YOUTUBE_COOKIE = 'SESSION_ID=abc123; YSC=xyz';
    const { agent, cookieMissing } = buildYtdlAgent();
    expect(cookieMissing).toBe(false);
    expect(agent).not.toBeNull();
    expect(typeof agent).toBe('object');
  });
});

