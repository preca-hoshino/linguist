import { db, generateShortId } from '@/db';
import { hashPassword } from '@/utils/hash';
import {
  countUsers,
  createUser,
  deleteUser,
  findByEmail,
  findById,
  getUserAvatarData,
  listUsers,
  updateUser,
} from '../repository';

jest.mock('@/db', () => ({
  db: { query: jest.fn() },
  generateShortId: jest.fn(),
}));

jest.mock('@/utils/hash', () => ({
  hashPassword: jest.fn(),
}));

describe('Users Repository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findByEmail', () => {
    it('should find exact user by email', async () => {
      const user = { id: 'usr_1', email: 'test@example.com', password_hash: 'hash' };
      (db.query as jest.Mock).mockResolvedValue({ rows: [user] });

      const result = await findByEmail('test@example.com');

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE email = $1'), ['test@example.com']);
      expect(result).toEqual(user);
    });

    it('should return null if user not found', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      const result = await findByEmail('missing@example.com');

      expect(result).toBeNull();
    });
  });

  describe('findById', () => {
    it('should find user without password_hash', async () => {
      const user = { id: 'usr_1', username: 'Test' };
      (db.query as jest.Mock).mockResolvedValue({ rows: [user] });

      const result = await findById('usr_1');

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['usr_1']);
      expect(result).toEqual(user);
    });
  });

  describe('listUsers', () => {
    it('should handle pagination and counting', async () => {
      const mockResult = {
        rows: [
          { id: '1', username: 'u1', total: '2' },
          { id: '2', username: 'u2', total: '2' },
        ],
      };
      (db.query as jest.Mock).mockResolvedValue(mockResult);

      const result = await listUsers({ limit: 10 });

      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      expect((result.data[0] as Record<string, unknown>).full_count).toBeUndefined();
    });

    it('should apply search logic', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      await listUsers({ search: 'testword' });

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('username ILIKE $1 OR email ILIKE $1'), [
        '%testword%',
        11,
      ]);
    });
  });

  describe('createUser', () => {
    it('should insert a user into DB', async () => {
      (generateShortId as jest.Mock).mockResolvedValue('usr_new');
      (hashPassword as jest.Mock).mockReturnValue('hashed_pass');

      const returnedRow = { id: 'usr_new', username: 'Test User' };
      (db.query as jest.Mock).mockResolvedValue({ rows: [returnedRow] });

      const result = await createUser({
        username: 'Test User',
        email: 'test@new.com',
        password: 'plain_password',
      });

      expect(generateShortId).toHaveBeenCalledWith('users');
      expect(hashPassword).toHaveBeenCalledWith('plain_password');
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), [
        'usr_new',
        'Test User',
        'test@new.com',
        'hashed_pass',
        '', // default avatar
      ]);
      expect(result).toEqual(returnedRow);
    });
  });

  describe('updateUser', () => {
    it('should update specific fields', async () => {
      const updatedUser = { id: 'usr_1', username: 'New Name' };
      (db.query as jest.Mock).mockResolvedValue({ rows: [updatedUser] });
      (hashPassword as jest.Mock).mockReturnValue('new_hash');

      const result = await updateUser('usr_1', { username: 'New Name', password: 'new_password' });

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET username = $1, password_hash = $2 WHERE id = $3'),
        ['New Name', 'new_hash', 'usr_1'],
      );
      expect(result).toEqual(updatedUser);
    });

    it('should return found user if sending empty updates', async () => {
      const user = { id: 'usr_1', username: 'Original' };
      (db.query as jest.Mock).mockResolvedValue({ rows: [user] });

      const result = await updateUser('usr_1', {});

      expect(result).toEqual(user);
    });
  });

  describe('getUserAvatarData', () => {
    it('should fetch avatar data', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [{ avatar_data: 'data:image/png;base64,...' }] });

      const result = await getUserAvatarData('usr_1');

      expect(result).toBe('data:image/png;base64,...');
    });

    it('should return null if user does not exist', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      const result = await getUserAvatarData('usr_unknown');

      expect(result).toBeNull();
    });
  });

  describe('deleteUser', () => {
    it('should delete a user and return true', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 1 });

      const result = await deleteUser('usr_1');

      expect(db.query).toHaveBeenCalledWith('DELETE FROM users WHERE id = $1', ['usr_1']);
      expect(result).toBe(true);
    });

    it('should return false if nothing deleted', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 0 });

      const result = await deleteUser('usr_1');

      expect(result).toBe(false);
    });
  });

  describe('countUsers', () => {
    it('should count users in the table', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [{ count: '42' }] });

      const result = await countUsers();

      expect(result).toBe(42);
    });

    it('should return 0 if no row returned', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      const result = await countUsers();

      expect(result).toBe(0);
    });
  });
});
