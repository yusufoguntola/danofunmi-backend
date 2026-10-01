#!/usr/bin/env node
// Generates the "we're live!" status-card graphic for posting on WhatsApp
// Status / Instagram Stories — a self-contained HTML file (real photos
// embedded as base64 data URIs, so it opens correctly with no server and no
// network beyond Google Fonts) sized as a 1080x1920 story. Open it in a
// browser, screenshot it (or use devtools' device toolbar at 1080x1920 for a
// pixel-perfect capture), and post the screenshot.
//
// Menu items with a real photo on file (lib/menuCatalog.js's IMAGE_ICON_RE)
// are shown as photo tiles; items still on an emoji icon fall back to a
// colored emoji tile so the card looks finished even before every item has
// a real photo uploaded (see routes/menu.js's icon upload/generate
// endpoints) — re-run this script after adding more real photos to pick
// them up.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db');
const { listActiveItems, IMAGE_ICON_RE } = require('../src/lib/menuCatalog');
const { MENU_ICONS_DIR } = require('../src/lib/uploads');

const OUTPUT_PATH = path.join(__dirname, '..', '..', 'idea_pad', 'go-live-status-card.html');

// Cycles through the brand's accent/neutral tones so emoji-fallback tiles
// don't all look identical — same palette as the rest of the card.
const TILE_TONES = ['#ece2cf', '#dfe8db', '#f0d9c6', '#e4ded0'];

async function photoDataUri(iconPath) {
  if (iconPath.startsWith('/uploads/menu-icons/')) {
    const filename = iconPath.replace('/uploads/menu-icons/', '');
    const buffer = fs.readFileSync(path.join(MENU_ICONS_DIR, filename));
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }
  // An external (e.g. Pexels) URL — fetch and inline so the card has no
  // runtime network dependency once generated.
  const res = await fetch(iconPath);
  if (!res.ok) throw new Error(`Could not fetch ${iconPath} (${res.status})`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function tileHtml(item, index) {
  if (IMAGE_ICON_RE.test(item.icon || '')) {
    const src = await photoDataUri(item.icon);
    return `<div class="tile">
      <img src="${src}" alt="${escapeHtml(item.name)}" />
      <span class="tile-label">${escapeHtml(item.name)}</span>
    </div>`;
  }
  const tone = TILE_TONES[index % TILE_TONES.length];
  return `<div class="tile tile--emoji" style="background:${tone};">
    <span class="tile-emoji">${item.icon || '🍽️'}</span>
    <span class="tile-label">${escapeHtml(item.name)}</span>
  </div>`;
}

async function main() {
  const items = (await listActiveItems()).slice(0, 6);
  const tiles = await Promise.all(items.map(tileHtml));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>dánọ́fúnmi — we're live</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,600;0,700;1,600;1,700&family=Nunito+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #16321f;
    --ink-soft: #33443a;
    --cream: #faf6ec;
    --mist: #f2f7ef;
    --terracotta: #c4652f;
    --muted: #7a897e;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #0e2016;
    display: flex;
    justify-content: center;
    font-family: 'Nunito Sans', Arial, Helvetica, sans-serif;
  }
  .card {
    width: 1080px;
    height: 1920px;
    position: relative;
    background: radial-gradient(120% 70% at 50% -10%, #1c4028 0%, var(--ink) 55%, #0f2416 100%);
    color: var(--cream);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* ambient steam, pure decoration — a quiet nod to the pot/fire mark */
  .steam { position: absolute; top: 40px; opacity: 0.35; }
  .steam path { stroke: var(--cream); stroke-width: 10; fill: none; stroke-linecap: round; }
  @media (prefers-reduced-motion: no-preference) {
    .steam { animation: drift 7s ease-in-out infinite; }
  }
  @keyframes drift { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-14px); } }

  .brand {
    display: flex;
    align-items: center;
    gap: 22px;
    padding: 96px 90px 0;
  }
  .brand-name {
    font-family: 'Fraunces', Georgia, serif;
    font-style: italic;
    font-weight: 700;
    font-size: 44px;
    letter-spacing: 0.01em;
  }
  .brand-tag {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(250, 246, 236, 0.7);
    margin-top: 6px;
  }

  .hero {
    padding: 72px 90px 0;
  }
  .eyebrow {
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--terracotta);
    text-wrap: balance;
  }
  h1 {
    margin: 18px 0 0;
    font-family: 'Fraunces', Georgia, serif;
    font-style: italic;
    font-weight: 700;
    font-size: 132px;
    line-height: 0.98;
    text-wrap: balance;
  }
  .hero p {
    margin: 30px 0 0;
    max-width: 760px;
    font-size: 32px;
    line-height: 1.45;
    color: rgba(250, 246, 236, 0.86);
  }

  .grid {
    margin-top: 64px;
    padding: 0 90px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 22px;
    flex: 1;
  }
  .tile {
    position: relative;
    border-radius: 26px;
    overflow: hidden;
    background: var(--mist);
    display: flex;
    align-items: flex-end;
  }
  .tile img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .tile--emoji { align-items: center; justify-content: center; flex-direction: column; gap: 14px; }
  .tile-emoji { font-size: 88px; line-height: 1; }
  .tile .tile-label {
    position: relative;
    width: 100%;
    padding: 20px 18px;
    font-size: 24px;
    font-weight: 800;
    color: var(--ink);
  }
  .tile img + .tile-label {
    color: var(--cream);
    background: linear-gradient(0deg, rgba(10, 24, 15, 0.82) 0%, rgba(10, 24, 15, 0) 100%);
    padding-top: 90px;
  }
  .tile--emoji .tile-label { text-align: center; padding-top: 0; }

  .cta {
    margin: 64px 90px 96px;
    padding: 44px 56px;
    border-radius: 28px;
    background: var(--terracotta);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }
  .cta-headline {
    font-family: 'Fraunces', Georgia, serif;
    font-style: italic;
    font-weight: 700;
    font-size: 42px;
  }
  .cta-sub {
    margin-top: 8px;
    font-size: 24px;
    font-weight: 700;
    color: rgba(250, 246, 236, 0.9);
  }
  .cta-arrow {
    font-size: 64px;
    line-height: 1;
  }
</style>
</head>
<body>
  <div class="card">
    <svg class="steam" width="160" height="90" viewBox="0 0 160 90" style="left: 820px;">
      <path d="M70 80 c -14 -18 10 -33 -2 -52 c -5 -8 -3 -13 1 -19" />
      <path d="M110 80 c 14 -18 -10 -33 2 -52 c 5 -8 3 -13 -1 -19" />
    </svg>

    <div class="brand">
      <svg width="76" height="76" viewBox="0 0 512 512" aria-hidden="true">
        <circle cx="256" cy="256" r="256" fill="#faf6ec" opacity="0.12" />
        <g fill="none" stroke="#faf6ec" stroke-width="16" stroke-linecap="round">
          <path d="M232 150 c -14 -18 10 -33 -2 -52 c -5 -8 -3 -13 1 -19" />
          <path d="M280 150 c 14 -18 -10 -33 2 -52 c 5 -8 3 -13 -1 -19" />
        </g>
        <path fill="#c4652f" d="M210 448 C 198 438 196 424 206 410 C 213 399 215 393 219 384 C 224 394 228 404 235 414 C 239 420 242 424 246 428 C 251 414 254 392 257 368 C 259 358 260 352 261 344 C 265 360 269 380 274 396 C 278 408 282 418 286 426 C 291 420 295 410 301 400 C 307 392 309 389 312 382 C 317 394 320 416 317 430 C 315 439 311 446 304 449 C 283 457 233 457 210 448 Z" />
        <path d="M190 164 A66 27 0 0 1 322 164 Z" fill="#c4652f" />
        <g fill="#faf6ec">
          <path d="M172 200 C 150 200 148 242 156 282 C 166 324 202 348 256 348 C 310 348 346 324 356 282 C 364 242 362 200 340 200 Z" />
          <path d="M158 208 c -30 2 -34 40 -2 48" fill="none" stroke="#faf6ec" stroke-width="16" stroke-linecap="round" />
          <path d="M354 208 c 30 2 34 40 2 48" fill="none" stroke="#faf6ec" stroke-width="16" stroke-linecap="round" />
          <rect x="150" y="168" width="212" height="34" rx="16" />
        </g>
      </svg>
      <div>
        <div class="brand-name">dánọ́fúnmi</div>
        <div class="brand-tag">You choose, we cook</div>
      </div>
    </div>

    <div class="hero">
      <div class="eyebrow">Ordering is open</div>
      <h1>We&rsquo;re&nbsp;live.</h1>
      <p>Pick your soups and rice, any combination — we cook it fresh and deliver it to you.</p>
    </div>

    <div class="grid">
      ${tiles.join('\n      ')}
    </div>

    <div class="cta">
      <div>
        <div class="cta-headline">danofunmi.com</div>
        <div class="cta-sub">@danofunmikitchen</div>
      </div>
      <div class="cta-arrow">&rarr;</div>
    </div>
  </div>
</body>
</html>
`;

  fs.writeFileSync(OUTPUT_PATH, html);
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Featured ${items.filter((i) => IMAGE_ICON_RE.test(i.icon || '')).length}/${items.length} items with a real photo.`);
  console.log('Open it in a browser, use devtools’ device toolbar at 1080x1920 for a pixel-perfect capture, and screenshot it to post.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
