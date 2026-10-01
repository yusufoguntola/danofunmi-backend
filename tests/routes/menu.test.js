jest.mock('../../src/db', () => ({
  menuItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  menuCategory: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  menuItemOption: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  menuGroup: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  menuGroupItem: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));
jest.mock('../../src/lib/uploads', () => ({
  uploadMenuIcon: { single: () => (req, res, next) => next() },
  MENU_ICONS_DIR: '/tmp/menu-icons',
}));
jest.mock('../../src/lib/generateIcon', () => ({ generateMenuIcon: jest.fn() }));
jest.mock('../../src/lib/menuCatalog', () => ({
  getCatalog: jest.fn(),
  shapeGroup: jest.fn((g) => ({ shaped: true, id: g.id })),
}));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), writeFileSync: jest.fn() }));
jest.mock('nanoid', () => ({ nanoid: () => 'fixedid8' }));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const prisma = require('../../src/db');
const { generateMenuIcon } = require('../../src/lib/generateIcon');
const { getCatalog, shapeGroup } = require('../../src/lib/menuCatalog');
const router = require('../../src/routes/menu');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/menu', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/menu', () => {
  test('returns the full catalog', async () => {
    getCatalog.mockResolvedValue([{ id: 'item1' }]);
    const res = await request(buildApp()).get('/api/menu');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'item1' }]);
  });
});

describe('GET /api/menu/admin/all', () => {
  test('flattens the category relation to a plain string', async () => {
    prisma.menuItem.findMany.mockResolvedValue([{ id: 'item1', name: 'Jollof', category: { name: 'Rice' }, options: [] }]);
    const res = await request(buildApp()).get('/api/menu/admin/all');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'item1', name: 'Jollof', category: 'Rice', options: [] }]);
  });

  test('category is null when an item has none', async () => {
    prisma.menuItem.findMany.mockResolvedValue([{ id: 'item1', category: null, options: [] }]);
    const res = await request(buildApp()).get('/api/menu/admin/all');
    expect(res.body[0].category).toBeNull();
  });

  // This route has no try/catch of its own — relies on express-async-errors
  // (see app.js) to forward a rejected promise to the error handler.
  test('an unexpected DB error reaches the error handler via express-async-errors', async () => {
    prisma.menuItem.findMany.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/menu/admin/all');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/menu/admin/categories', () => {
  test('lists categories', async () => {
    prisma.menuCategory.findMany.mockResolvedValue([{ id: 'cat1', name: 'Soups' }]);
    const res = await request(buildApp()).get('/api/menu/admin/categories');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/menu/admin/categories', () => {
  test('400 when name is missing', async () => {
    const res = await request(buildApp()).post('/api/menu/admin/categories').send({});
    expect(res.status).toBe(400);
  });

  test('201 creates the category', async () => {
    prisma.menuCategory.create.mockResolvedValue({ id: 'cat1', name: 'Soups' });
    const res = await request(buildApp()).post('/api/menu/admin/categories').send({ name: 'Soups' });
    expect(res.status).toBe(201);
  });

  test('409 on a duplicate name', async () => {
    prisma.menuCategory.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = await request(buildApp()).post('/api/menu/admin/categories').send({ name: 'Soups' });
    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/menu/admin/categories/:id', () => {
  test('renames the category', async () => {
    prisma.menuCategory.update.mockResolvedValue({ id: 'cat1', name: 'Renamed' });
    const res = await request(buildApp()).patch('/api/menu/admin/categories/cat1').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
  });

  test('404 when not found', async () => {
    prisma.menuCategory.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).patch('/api/menu/admin/categories/missing').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  test('409 on a duplicate name', async () => {
    prisma.menuCategory.update.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = await request(buildApp()).patch('/api/menu/admin/categories/cat1').send({ name: 'Dup' });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/menu/admin/categories/:id', () => {
  test('204 on success', async () => {
    prisma.menuCategory.delete.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/menu/admin/categories/cat1');
    expect(res.status).toBe(204);
  });

  test('404 when not found', async () => {
    prisma.menuCategory.delete.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).delete('/api/menu/admin/categories/missing');
    expect(res.status).toBe(404);
  });

  test('409 when the category still has items (foreign key constraint)', async () => {
    prisma.menuCategory.delete.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    const res = await request(buildApp()).delete('/api/menu/admin/categories/cat1');
    expect(res.status).toBe(409);
  });

  test('500 on an unrelated error (handled explicitly, not rethrown)', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.menuCategory.delete.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).delete('/api/menu/admin/categories/cat1');
    expect(res.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});

describe('GET /api/menu/admin/:id', () => {
  test('404 when not found', async () => {
    prisma.menuItem.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/menu/admin/missing');
    expect(res.status).toBe(404);
  });

  test('returns the flattened item', async () => {
    prisma.menuItem.findUnique.mockResolvedValue({ id: 'item1', category: { name: 'Soups' }, options: [] });
    const res = await request(buildApp()).get('/api/menu/admin/item1');
    expect(res.status).toBe(200);
    expect(res.body.category).toBe('Soups');
  });
});

describe('POST /api/menu/admin/icons/upload', () => {
  test('400 when no file is attached (mocked multer never sets req.file)', async () => {
    const res = await request(buildApp()).post('/api/menu/admin/icons/upload').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/menu/admin/icons/generate', () => {
  test('400 when name is missing', async () => {
    const res = await request(buildApp()).post('/api/menu/admin/icons/generate').send({});
    expect(res.status).toBe(400);
  });

  test('201 writes the generated buffer to disk and returns its path', async () => {
    generateMenuIcon.mockResolvedValue(Buffer.from([1, 2, 3]));
    const res = await request(buildApp()).post('/api/menu/admin/icons/generate').send({ name: 'Jollof Rice' });

    expect(res.status).toBe(201);
    // filename is `${Date.now()}-${nanoid(8)}.jpg` — nanoid is mocked fixed, Date.now() isn't.
    expect(res.body.path).toMatch(/^\/uploads\/menu-icons\/\d+-fixedid8\.jpg$/);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  test('propagates the generator error status/message', async () => {
    generateMenuIcon.mockRejectedValue(Object.assign(new Error('AI icon generation failed (503)'), { status: 502 }));
    const res = await request(buildApp()).post('/api/menu/admin/icons/generate').send({ name: 'X' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('AI icon generation failed');
  });

  test('defaults to 500 when the generator error has no status', async () => {
    generateMenuIcon.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).post('/api/menu/admin/icons/generate').send({ name: 'X' });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/menu/admin', () => {
  test('400 when required fields are missing', async () => {
    const res = await request(buildApp()).post('/api/menu/admin').send({ name: 'Jollof' });
    expect(res.status).toBe(400);
  });

  test('400 when options is an empty array', async () => {
    const res = await request(buildApp())
      .post('/api/menu/admin')
      .send({ name: 'Jollof', categoryId: 'cat1', options: [] });
    expect(res.status).toBe(400);
  });

  test('201 creates the item with its options', async () => {
    prisma.menuItem.create.mockResolvedValue({ id: 'item1', name: 'Jollof', category: { name: 'Rice' }, options: [] });
    const res = await request(buildApp())
      .post('/api/menu/admin')
      .send({ name: 'Jollof', categoryId: 'cat1', options: [{ size: '1L', price: 5000 }] });
    expect(res.status).toBe(201);
  });

  test('409 on a duplicate name', async () => {
    prisma.menuItem.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = await request(buildApp())
      .post('/api/menu/admin')
      .send({ name: 'Jollof', categoryId: 'cat1', options: [{ size: '1L', price: 5000 }] });
    expect(res.status).toBe(409);
  });

  test('400 on a bad category reference', async () => {
    prisma.menuItem.create.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    const res = await request(buildApp())
      .post('/api/menu/admin')
      .send({ name: 'Jollof', categoryId: 'bad-cat', options: [{ size: '1L', price: 5000 }] });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/menu/admin/:id', () => {
  test('updates and flattens the result', async () => {
    prisma.menuItem.update.mockResolvedValue({ id: 'item1', category: { name: 'Soups' }, options: [] });
    const res = await request(buildApp()).patch('/api/menu/admin/item1').send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.category).toBe('Soups');
  });

  test('400 on a bad category reference', async () => {
    prisma.menuItem.update.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    const res = await request(buildApp()).patch('/api/menu/admin/item1').send({ categoryId: 'bad' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/menu/admin/:id', () => {
  test('204 on success', async () => {
    prisma.menuItem.delete.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/menu/admin/item1');
    expect(res.status).toBe(204);
  });

  test('404 when not found', async () => {
    prisma.menuItem.delete.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).delete('/api/menu/admin/missing');
    expect(res.status).toBe(404);
  });

  test('409 when the item has already been ordered', async () => {
    prisma.menuItem.delete.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    const res = await request(buildApp()).delete('/api/menu/admin/item1');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been ordered/);
  });
});

describe('POST /api/menu/admin/:id/options', () => {
  test('400 when size or price missing', async () => {
    const res = await request(buildApp()).post('/api/menu/admin/item1/options').send({ size: '1L' });
    expect(res.status).toBe(400);
  });

  test('201 creates the option', async () => {
    prisma.menuItemOption.create.mockResolvedValue({ id: 'opt1', size: '1L', price: 5000 });
    const res = await request(buildApp()).post('/api/menu/admin/item1/options').send({ size: '1L', price: 5000 });
    expect(res.status).toBe(201);
  });

  test('a price of 0 is accepted (not treated as missing)', async () => {
    prisma.menuItemOption.create.mockResolvedValue({ id: 'opt1', size: 'Free', price: 0 });
    const res = await request(buildApp()).post('/api/menu/admin/item1/options').send({ size: 'Free', price: 0 });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/menu/admin/options/:optionId', () => {
  test('updates price/active', async () => {
    prisma.menuItemOption.update.mockResolvedValue({ id: 'opt1', price: 6000, active: false });
    const res = await request(buildApp()).patch('/api/menu/admin/options/opt1').send({ price: 6000, active: false });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/menu/admin/options/:optionId', () => {
  test('409 when the option is used in a combo', async () => {
    prisma.menuGroupItem.findFirst.mockResolvedValue({ id: 'gi1' });
    const res = await request(buildApp()).delete('/api/menu/admin/options/opt1');
    expect(res.status).toBe(409);
    expect(prisma.menuItemOption.delete).not.toHaveBeenCalled();
  });

  test('204 on success', async () => {
    prisma.menuGroupItem.findFirst.mockResolvedValue(null);
    prisma.menuItemOption.delete.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/menu/admin/options/opt1');
    expect(res.status).toBe(204);
  });

  test('404 when not found', async () => {
    prisma.menuGroupItem.findFirst.mockResolvedValue(null);
    prisma.menuItemOption.delete.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).delete('/api/menu/admin/options/missing');
    expect(res.status).toBe(404);
  });

  test('409 when the option has already been ordered', async () => {
    prisma.menuGroupItem.findFirst.mockResolvedValue(null);
    prisma.menuItemOption.delete.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    const res = await request(buildApp()).delete('/api/menu/admin/options/opt1');
    expect(res.status).toBe(409);
  });
});

describe('Combos (menu groups)', () => {
  test('GET /admin/groups/all shapes every group', async () => {
    prisma.menuGroup.findMany.mockResolvedValue([{ id: 'grp1' }, { id: 'grp2' }]);
    const res = await request(buildApp()).get('/api/menu/admin/groups/all');
    expect(res.status).toBe(200);
    expect(shapeGroup).toHaveBeenCalledTimes(2);
  });

  test('GET /admin/groups/:id — 404 when not found', async () => {
    prisma.menuGroup.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/menu/admin/groups/missing');
    expect(res.status).toBe(404);
  });

  test('GET /admin/groups/:id — shapes and returns the group', async () => {
    prisma.menuGroup.findUnique.mockResolvedValue({ id: 'grp1' });
    const res = await request(buildApp()).get('/api/menu/admin/groups/grp1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shaped: true, id: 'grp1' });
  });

  describe('POST /admin/groups', () => {
    test('400 when required fields are missing', async () => {
      const res = await request(buildApp()).post('/api/menu/admin/groups').send({ name: 'Combo' });
      expect(res.status).toBe(400);
    });

    test('400 on an invalid discountType', async () => {
      const res = await request(buildApp())
        .post('/api/menu/admin/groups')
        .send({ name: 'Combo', categoryId: 'cat1', discountType: 'BOGUS', items: [{ menuItemOptionId: 'opt1' }] });
      expect(res.status).toBe(400);
    });

    test('201 creates the combo', async () => {
      prisma.menuGroup.create.mockResolvedValue({ id: 'grp1' });
      const res = await request(buildApp())
        .post('/api/menu/admin/groups')
        .send({ name: 'Combo', categoryId: 'cat1', items: [{ menuItemOptionId: 'opt1', quantity: 1 }] });
      expect(res.status).toBe(201);
    });

    test('409 on a duplicate name', async () => {
      prisma.menuGroup.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
      const res = await request(buildApp())
        .post('/api/menu/admin/groups')
        .send({ name: 'Combo', categoryId: 'cat1', items: [{ menuItemOptionId: 'opt1' }] });
      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /admin/groups/:id', () => {
    test('400 on an invalid discountType', async () => {
      const res = await request(buildApp()).patch('/api/menu/admin/groups/grp1').send({ discountType: 'BOGUS' });
      expect(res.status).toBe(400);
    });

    test('updates the combo', async () => {
      prisma.menuGroup.update.mockResolvedValue({ id: 'grp1' });
      const res = await request(buildApp()).patch('/api/menu/admin/groups/grp1').send({ active: false });
      expect(res.status).toBe(200);
    });

    test('404 when not found', async () => {
      prisma.menuGroup.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
      const res = await request(buildApp()).patch('/api/menu/admin/groups/missing').send({ active: false });
      expect(res.status).toBe(404);
    });

    test('leaves discount untouched when discountType key is absent from the body', async () => {
      prisma.menuGroup.update.mockResolvedValue({ id: 'grp1' });
      await request(buildApp()).patch('/api/menu/admin/groups/grp1').send({ active: false });
      const data = prisma.menuGroup.update.mock.calls[0][0].data;
      expect('discountType' in data).toBe(false);
    });

    test('clears the discount when discountType is explicitly set to null/empty', async () => {
      prisma.menuGroup.update.mockResolvedValue({ id: 'grp1' });
      await request(buildApp()).patch('/api/menu/admin/groups/grp1').send({ discountType: '' });
      const data = prisma.menuGroup.update.mock.calls[0][0].data;
      expect(data.discountType).toBeNull();
      expect(data.discountValue).toBeNull();
    });
  });

  test('DELETE /admin/groups/:id — 409 when already ordered', async () => {
    prisma.menuGroup.delete.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    const res = await request(buildApp()).delete('/api/menu/admin/groups/grp1');
    expect(res.status).toBe(409);
  });

  describe('POST /admin/groups/:id/items', () => {
    test('400 when menuItemOptionId is missing', async () => {
      const res = await request(buildApp()).post('/api/menu/admin/groups/grp1/items').send({});
      expect(res.status).toBe(400);
    });

    test('201 adds the item and returns the reshaped group', async () => {
      prisma.menuGroupItem.create.mockResolvedValue({});
      prisma.menuGroup.findUnique.mockResolvedValue({ id: 'grp1' });
      const res = await request(buildApp()).post('/api/menu/admin/groups/grp1/items').send({ menuItemOptionId: 'opt1' });
      expect(res.status).toBe(201);
    });

    test('400 on a bad menuItemOptionId reference', async () => {
      prisma.menuGroupItem.create.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
      const res = await request(buildApp()).post('/api/menu/admin/groups/grp1/items').send({ menuItemOptionId: 'bad' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /admin/groups/items/:itemId', () => {
    test('updates quantity/isBonus and returns the reshaped parent group', async () => {
      prisma.menuGroupItem.update.mockResolvedValue({ groupId: 'grp1' });
      prisma.menuGroup.findUnique.mockResolvedValue({ id: 'grp1' });
      const res = await request(buildApp()).patch('/api/menu/admin/groups/items/gi1').send({ quantity: 2 });
      expect(res.status).toBe(200);
    });

    test('404 when the included item does not exist', async () => {
      prisma.menuGroupItem.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
      const res = await request(buildApp()).patch('/api/menu/admin/groups/items/missing').send({ quantity: 2 });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /admin/groups/items/:itemId', () => {
    test('removes the item and returns the reshaped parent group', async () => {
      prisma.menuGroupItem.delete.mockResolvedValue({ groupId: 'grp1' });
      prisma.menuGroup.findUnique.mockResolvedValue({ id: 'grp1' });
      const res = await request(buildApp()).delete('/api/menu/admin/groups/items/gi1');
      expect(res.status).toBe(200);
    });

    test('404 when the included item does not exist', async () => {
      prisma.menuGroupItem.delete.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
      const res = await request(buildApp()).delete('/api/menu/admin/groups/items/missing');
      expect(res.status).toBe(404);
    });

    test('500 on an unrelated error (handled explicitly, not rethrown)', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      prisma.menuGroupItem.delete.mockRejectedValue(new Error('DB down'));
      const res = await request(buildApp()).delete('/api/menu/admin/groups/items/gi1');
      expect(res.status).toBe(500);
      consoleErrorSpy.mockRestore();
    });
  });
});
