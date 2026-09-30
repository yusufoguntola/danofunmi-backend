// Two ways to get a menu item's icon image: search Pexels for a real,
// free-to-use stock photo of the dish (preferred — a real photo of "Buka
// Stew" beats an AI-synthesized approximation), falling back to generating
// one via Pollinations if Pexels isn't configured or has no good match.
//
// Shutterstock and other paid/licensed stock sites are deliberately NOT
// wired up here — downloading their images without an actual paid license
// would be copyright infringement. Pexels was picked because it's genuinely
// free: a free API key (no card, no approval wait) and a license that
// explicitly permits this kind of use with no attribution required
// (https://www.pexels.com/license/).
const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';

function isPexelsConfigured() {
    return !!process.env.PEXELS_API_KEY;
}

/** Searches Pexels for `query`, returns the top result's image as a Buffer,
 * or null if Pexels has nothing good (never throws for a "no match" —
 * only for an actual network/API failure, so the caller can fall back to
 * generation either way). */
async function searchPexelsPhoto(query) {
    const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=1&orientation=square`;
    const res = await fetch(url, {headers: {Authorization: process.env.PEXELS_API_KEY}});
    if (!res.ok) throw new Error(`Pexels search failed (${res.status})`);

    const data = await res.json();
    const photo = data.photos?.[0];
    const imageUrl = photo?.src?.large || photo?.src?.medium || photo?.src?.original;
    if (!imageUrl) return null;

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Could not download the matched Pexels photo (${imgRes.status})`);
    return Buffer.from(await imgRes.arrayBuffer());
}

const STYLE_PREFIX = 'A simple, modern flat icon of ';
const STYLE_SUFFIX =
    ', centered, minimal flat illustration style, bold clean shapes, soft warm color palette, plain white background, no text, no watermark';

/** Pollinations (image.pollinations.ai) — a free, unauthenticated image
 * generation endpoint. No API key, no billing account, no signup. It's a
 * best-effort public service (no uptime/quality SLA), which is the
 * trade-off for "free" — the fallback path when there's no real photo to
 * use instead. */
async function generateWithPollinations(subject) {
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

    return Buffer.from(await res.arrayBuffer());
}

async function generateMenuIcon({name, description}) {
    const subject = [name, description].filter(Boolean).join(' — ');

    if (isPexelsConfigured()) {
        try {
            const photo = await searchPexelsPhoto(subject);
            if (photo) return photo;
        } catch (err) {
            // A real photo is the preference, not a hard requirement — fall
            // through to generation rather than fail the whole request over
            // a Pexels hiccup.
            console.error('Pexels photo search failed, falling back to AI generation:', err.message);
        }
    }

    return generateWithPollinations(subject);
}

module.exports = {generateMenuIcon};
