const { generateMenuIcon } = require('../../src/lib/generateIcon');

const ORIGINAL_PEXELS_KEY = process.env.PEXELS_API_KEY;

function fakeArrayBuffer(bytes) {
  return new Uint8Array(bytes).buffer;
}

describe('generateMenuIcon', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    global.fetch = jest.fn();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.PEXELS_API_KEY = ORIGINAL_PEXELS_KEY;
    delete global.fetch;
    consoleErrorSpy.mockRestore();
  });

  test('without PEXELS_API_KEY, goes straight to Pollinations generation', async () => {
    delete process.env.PEXELS_API_KEY;
    global.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => fakeArrayBuffer([1, 2, 3]) });

    const buf = await generateMenuIcon({ name: 'Jollof Rice' });

    expect(buf).toEqual(Buffer.from([1, 2, 3]));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('image.pollinations.ai/prompt/');
  });

  test('with PEXELS_API_KEY, prefers a Pexels photo when one matches', async () => {
    process.env.PEXELS_API_KEY = 'pexels-key';
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: [{ src: { large: 'https://images.pexels.com/photo.jpg' } }] }),
      })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => fakeArrayBuffer([9, 9]) });

    const buf = await generateMenuIcon({ name: 'Jollof Rice', description: 'party rice' });

    expect(buf).toEqual(Buffer.from([9, 9]));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toContain('api.pexels.com/v1/search?query=Jollof%20Rice%20%E2%80%94%20party%20rice');
    expect(global.fetch.mock.calls[0][1]).toEqual({ headers: { Authorization: 'pexels-key' } });
  });

  test('falls back to Pollinations when Pexels has no match', async () => {
    process.env.PEXELS_API_KEY = 'pexels-key';
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [] }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => fakeArrayBuffer([5]) });

    const buf = await generateMenuIcon({ name: 'Obscure Dish' });

    expect(buf).toEqual(Buffer.from([5]));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toContain('image.pollinations.ai');
  });

  test('falls back to Pollinations when the Pexels search itself errors', async () => {
    process.env.PEXELS_API_KEY = 'pexels-key';
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => fakeArrayBuffer([2]) });

    const buf = await generateMenuIcon({ name: 'Efo Riro' });

    expect(buf).toEqual(Buffer.from([2]));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Pexels photo search failed, falling back to AI generation:',
      expect.stringContaining('Pexels search failed (500)')
    );
  });

  test('falls back when downloading the matched Pexels photo fails', async () => {
    process.env.PEXELS_API_KEY = 'pexels-key';
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [{ src: { medium: 'https://x/img.jpg' } }] }) })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => fakeArrayBuffer([7]) });

    const buf = await generateMenuIcon({ name: 'Egusi' });

    expect(buf).toEqual(Buffer.from([7]));
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('Pollinations failure surfaces as a 502 error', async () => {
    delete process.env.PEXELS_API_KEY;
    global.fetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(generateMenuIcon({ name: 'Anything' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('AI icon generation failed (503)'),
    });
  });

  test('a Pollinations network error is wrapped with a friendly message', async () => {
    delete process.env.PEXELS_API_KEY;
    global.fetch.mockRejectedValue(new Error('ECONNRESET'));

    await expect(generateMenuIcon({ name: 'Anything' })).rejects.toMatchObject({
      status: 502,
      message: 'Could not reach the AI icon generation service.',
    });
  });

  test('a Pollinations timeout (AbortError) gets its own message', async () => {
    delete process.env.PEXELS_API_KEY;
    global.fetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(generateMenuIcon({ name: 'Anything' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('timed out'),
    });
  });
});
