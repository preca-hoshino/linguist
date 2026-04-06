import { hashPassword, verifyPassword } from '../hash';

describe('hash util', () => {
  describe('hashPassword', () => {
    it('should securely hash the password returning correct format', () => {
      const password = 'mySecretPassword123!';
      const hash = hashPassword(password);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.startsWith('scrypt:')).toBeTruthy();

      const parts = hash.split(':');
      expect(parts.length).toBe(3);
      expect(parts[1]).toBeDefined(); // salt
      expect(parts[2]).toBeDefined(); // actual output
    });
  });

  describe('verifyPassword', () => {
    it('should return true for valid password against its hash', () => {
      const password = 'mySecretPassword123!';
      const hash = hashPassword(password);

      const result = verifyPassword(password, hash);
      expect(result).toBe(true);
    });

    it('should return false for incorrect password', () => {
      const password = 'mySecretPassword123!';
      const wrongPassword = 'wrongPassword!';
      const hash = hashPassword(password);

      const result = verifyPassword(wrongPassword, hash);
      expect(result).toBe(false);
    });

    it('should return false for malformed hash without 3 parts', () => {
      const result = verifyPassword('any', 'scrypt:just-two-parts');
      expect(result).toBe(false);
    });

    it('should return false if hash does not start with scrypt', () => {
      const result = verifyPassword('any', 'bcrypt:salt:hash');
      expect(result).toBe(false);
    });

    it('should return false if it is just random string', () => {
      const result = verifyPassword('any', 'invalid_string_format');
      expect(result).toBe(false);
    });
  });
});
