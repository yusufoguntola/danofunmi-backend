const prisma = require('../db');

/** Best-effort — writes an ErrorLog row so admin has somewhere to review
 * unexpected errors (see the "Error logs" admin page). Deliberately never
 * throws itself: a logging failure (e.g. the DB being the thing that's
 * down) must never mask or replace the original error it's trying to
 * record, or break the route that called it. */
async function logError({ source, message, stack, context }) {
  try {
    await prisma.errorLog.create({
      data: {
        source,
        message: String(message || 'Unknown error').slice(0, 2000),
        stack: stack ? String(stack).slice(0, 8000) : null,
        context: context ?? undefined,
      },
    });
  } catch (err) {
    console.error('logError itself failed:', err);
  }
}

module.exports = { logError };
