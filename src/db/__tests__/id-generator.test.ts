import { generateShortId } from '../id-generator';
import { db } from '../client';

jest.mock('../client', () => ({
  db: {
    query: jest.fn(),
  },
}));

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;

describe('generateShortId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should generate id with users prefix for users table', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('users');
    expect(id).toMatch(/^usr_[0-9a-f]{6}$/);
  });

  it('should generate id with apps prefix for apps table', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('apps');
    expect(id).toMatch(/^app_[0-9a-f]{6}$/);
  });

  it('should generate id with model_pvd prefix for model_providers table', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('model_providers');
    expect(id).toMatch(/^model_pvd_[0-9a-f]{6}$/);
  });

  it('should generate id with model_p prefix for model_provider_models table', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('model_provider_models');
    expect(id).toMatch(/^model_p_[0-9a-f]{6}$/);
  });

  it('should generate id with model_v prefix for virtual_models table', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('virtual_models');
    expect(id).toMatch(/^model_v_[0-9a-f]{6}$/);
  });

  it('should generate id with mcp_p prefix for mcp_providers table', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('mcp_providers');
    expect(id).toMatch(/^mcp_p_[0-9a-f]{6}$/);
  });

  it('should generate id with mcp_v prefix for virtual_mcps table', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('virtual_mcps');
    expect(id).toMatch(/^mcp_v_[0-9a-f]{6}$/);
  });

  it('should query the correct table in the uniqueness check', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    await generateShortId('users');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sqlText = mockQuery.mock.calls[0]?.[0];
    expect(sqlText).toContain('FROM users');
  });

  it('should throw for non-allowed table name', async () => {
    await expect(generateShortId('unknown_table')).rejects.toThrow(
      'Table "unknown_table" is not allowed for short ID generation',
    );
  });

  it('should retry on collision (rowCount > 0)', async () => {
    // First call: collision (rowCount > 0), second: success
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'exists' }], command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });

    const id = await generateShortId('users');
    expect(id).toMatch(/^usr_[0-9a-f]{6}$/);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('should retry multiple times on repeated collisions', async () => {
    // Two collisions, then success
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'exists1' }], command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'exists2' }], command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });

    const id = await generateShortId('apps');
    expect(id).toMatch(/^app_[0-9a-f]{6}$/);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('should generate hex segment of exactly 6 characters', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] });
    const id = await generateShortId('users');
    const hexPart = id.split('_')[1];
    expect(hexPart).toHaveLength(6);
  });
});
