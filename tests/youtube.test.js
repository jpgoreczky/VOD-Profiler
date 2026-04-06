'use strict';

const { isYouTubeUrl } = require('../src/services/youtube');

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
