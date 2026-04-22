import crypto from 'node:crypto';
import { signToken, verifyToken } from '../jwt';

describe('jwt util', () => {
  const SECRET = 'test-secret';
  const PAYLOAD = { sub: 'user123' };

  describe('signToken', () => {
    it('should generate a valid JWT with default expiration', () => {
      const token = signToken(PAYLOAD, SECRET);
      const parts = token.split('.');
      expect(parts.length).toBe(3);

      const payload = verifyToken(token, SECRET);
      expect(payload?.sub).toBe(PAYLOAD.sub);
      expect(payload?.iat).toBeDefined();
      expect(payload?.exp).toBeDefined();
    });

    it('should generate a valid JWT with custom expiration', () => {
      const token = signToken(PAYLOAD, SECRET, 3600);
      const payload = verifyToken(token, SECRET);
      expect(payload).not.toBeNull();
      if (!payload) {
        throw new Error('payload is null');
      }
      expect(payload.exp - payload.iat).toBe(3600);
    });
  });

  describe('verifyToken', () => {
    it('should return null if token does not have 3 parts', () => {
      expect(verifyToken('invalid.token', SECRET)).toBeNull();
    });

    it('should return null if signature is invalid', () => {
      const token = signToken(PAYLOAD, SECRET);
      const [header = '', body = ''] = token.split('.');
      const mutatedToken = `${header}.${body}.invalid_signature`;
      expect(verifyToken(mutatedToken, SECRET)).toBeNull();
    });

    it('should return null if token is expired', () => {
      // expired 1 second ago
      const token = signToken(PAYLOAD, SECRET, -1);
      expect(verifyToken(token, SECRET)).toBeNull();
    });

    it('should return null if JSON parsing fails', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const badBody = Buffer.from('invalid json').toString('base64url');
      const signature = crypto.createHmac('sha256', SECRET).update(`${header}.${badBody}`).digest('base64url');

      const token = `${header}.${badBody}.${signature}`;
      expect(verifyToken(token, SECRET)).toBeNull();
    });

    it('should return empty false on wrong secret', () => {
      const token = signToken(PAYLOAD, 'real-secret');
      expect(verifyToken(token, 'fake-secret')).toBeNull();
    });
  });
});
