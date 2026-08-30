// FRONTEND_ORIGIN accepts one origin or a comma-separated list, e.g.
// FRONTEND_ORIGIN="https://danofunmi.com,https://www.danofunmi.com". Shared
// by index.js (CORS) and middleware/security.js (requireBrowserOrigin) so
// both stay in sync with whatever origins are actually allowed.
function getFrontendOrigins() {
    const raw = process.env.FRONTEND_ORIGIN;
    if (!raw) return [];

    const cleanedRaw = raw.replace(/^["']|["']$/g, '').trim();
    return cleanedRaw
        .split(',')
        .map((origin) => origin.trim().replace(/^["']|["']$/g, '')) // clean individual items
        .filter(Boolean);
}

module.exports = {getFrontendOrigins};
