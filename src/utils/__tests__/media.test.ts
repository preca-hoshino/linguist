import { mimeToMediaType } from '../media';

describe('mimeToMediaType', () => {
  it('should return image for image MIME types', () => {
    expect(mimeToMediaType('image/png')).toBe('image');
    expect(mimeToMediaType('image/jpeg')).toBe('image');
    expect(mimeToMediaType('image/webp')).toBe('image');
    expect(mimeToMediaType('image/gif')).toBe('image');
  });

  it('should return audio for audio MIME types', () => {
    expect(mimeToMediaType('audio/mpeg')).toBe('audio');
    expect(mimeToMediaType('audio/wav')).toBe('audio');
    expect(mimeToMediaType('audio/ogg')).toBe('audio');
  });

  it('should return video for video MIME types', () => {
    expect(mimeToMediaType('video/mp4')).toBe('video');
    expect(mimeToMediaType('video/webm')).toBe('video');
  });

  it('should return file for all other MIME types', () => {
    expect(mimeToMediaType('application/pdf')).toBe('file');
    expect(mimeToMediaType('text/plain')).toBe('file');
    expect(mimeToMediaType('application/json')).toBe('file');
    expect(mimeToMediaType('application/octet-stream')).toBe('file');
  });

  it('should return file for unknown or malformed MIME', () => {
    expect(mimeToMediaType('')).toBe('file');
  });
});
