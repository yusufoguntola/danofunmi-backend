const Anthropic = require('@anthropic-ai/sdk');
const { getCatalog } = require('./menuCatalog');

const MODEL = 'claude-opus-5';

class ChatNotConfiguredError extends Error {}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new ChatNotConfiguredError('ANTHROPIC_API_KEY is not set');
  }
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You turn a customer's free-text bulk/custom food order request into a structured
list of line items, matched against the menu catalog given to you wherever possible. Respond with ONLY a
JSON array (no prose, no markdown fences), each entry shaped exactly like:
{"itemName": string, "size": string, "quantity": integer >= 1, "menuItemOptionId": string|null}.
Use menuItemOptionId only when an entry clearly matches one specific catalog option; leave it null for
anything off-menu, custom, or ambiguous (still guess a reasonable itemName/size then). If the request
gives no usable quantity/size signal for an item, default quantity to 1 and pick the smallest listed
size. Never invent a price. If nothing in the message describes an actual food item, return [].`;

/** Best-effort guess at the line items behind a logged ExtraneousRequest's
 * free-text message — used to pre-fill the admin's "Create order" modal
 * (routes/requests.js), which the admin always reviews/edits before saving.
 * Never trusts a price from the model: any line matched to a real
 * MenuItemOption is repriced from the catalog server-side; unmatched
 * (off-menu) lines come back with unitPrice 0 for the admin to fill in. */
async function suggestItemsFromMessage(message) {
  const catalog = await getCatalog();
  const catalogSummary = catalog
    .map((entry) =>
      entry.type === 'item'
        ? `- ${entry.name} (${entry.category}): ${entry.options.map((o) => `${o.size} @ ₦${o.price} [id:${o.id}]`).join(', ')}`
        : `- ${entry.name} (combo, ${entry.category}): ₦${entry.total}`
    )
    .join('\n');

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Menu catalog:\n${catalogSummary}\n\nCustomer request:\n"""${message}"""` }],
  });

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let guesses;
  try {
    guesses = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    guesses = match ? JSON.parse(match[0]) : [];
  }
  if (!Array.isArray(guesses)) return [];

  const optionsById = new Map();
  for (const entry of catalog) {
    if (entry.type !== 'item') continue;
    for (const opt of entry.options) {
      optionsById.set(opt.id, { itemName: entry.name, size: opt.size, unitPrice: opt.price });
    }
  }

  return guesses
    .filter((g) => g && typeof g === 'object')
    .slice(0, 20)
    .map((g) => {
      const quantity = Number.isInteger(g.quantity) && g.quantity > 0 ? g.quantity : 1;
      const match = g.menuItemOptionId ? optionsById.get(g.menuItemOptionId) : null;
      if (match) {
        return { itemName: match.itemName, size: match.size, quantity, unitPrice: match.unitPrice, matched: true };
      }
      return {
        itemName: String(g.itemName || 'Item').slice(0, 100),
        size: String(g.size || '').slice(0, 50) || 'Standard',
        quantity,
        unitPrice: 0,
        matched: false,
      };
    });
}

module.exports = { suggestItemsFromMessage, ChatNotConfiguredError };
