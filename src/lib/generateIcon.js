// Uses Pollinations (image.pollinations.ai) — a free, unauthenticated image
// generation endpoint. No API key, no billing account, no signup. It's a
// best-effort public service (no uptime/quality SLA), which is the trade-off
// for "free" — swap this file for a paid provider later if that matters more
// than cost.
const STYLE_PREFIX = 'A simple, modern flat icon of ';
const STYLE_SUFFIX =
    ', centered, minimal flat illustration style, bold clean shapes, soft warm color palette, plain white background, no text, no watermark';

async function generateMenuIcon({name, description}) {
    const subject = [name, description].filter(Boolean).join(' — ');
    const prompt = `${STYLE_PREFIX}${subject}${STYLE_SUFFIX}`;
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let res;
    try {
        res = await fetch(url, {signal: controller.signal});
    } catch (err) {
        const wrapped = new Error(
            err.name === 'AbortError'
                ? 'AI icon generation timed out — the free image service can be slow. Try again.'
                : 'Could not reach the AI icon generation service.'
        );
        wrapped.status = 502;
        throw wrapped;
    } finally {
        clearTimeout(timeout);
    }

    if (!res.ok) {
        const err = new Error(`AI icon generation failed (${res.status})`);
        err.status = 502;
        throw err;
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

module.exports = {generateMenuIcon};
