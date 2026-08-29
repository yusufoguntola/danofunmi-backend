const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { optionalCustomerAuth } = require('../middleware/auth');
const { requireBrowserOrigin } = require('../middleware/security');
const { runChat, ChatNotConfiguredError } = require('../lib/aiAgent');

const router = express.Router();

const MAX_MESSAGES = 60;

// POST /api/chat — public, stateless. The client resends its full stored
// conversation each turn (see frontend ChatWidget); we never trust a
// client-supplied system prompt, only the message history. optionalCustomerAuth
// lets a signed-in customer's orders link to their account (and tells the
// agent not to pitch account creation).
router.post('/', requireBrowserOrigin, optionalCustomerAuth, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(400).json({ error: 'This conversation has gotten long — please start a new one.' });
  }

  try {
    const { messages: updated, meta } = await runChat(messages, {
      authenticatedCustomerId: req.customer?.id,
      isAuthenticated: !!req.customer,
    });
    res.json({ messages: updated, meta });
  } catch (err) {
    if (err instanceof ChatNotConfiguredError) {
      return res.status(500).json({ error: 'Chat isn\'t set up yet — please order using the menu instead.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('Chat is not configured (ANTHROPIC_API_KEY missing/invalid):', err.message);
      return res.status(500).json({ error: 'Chat isn\'t set up yet — please order using the menu instead.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'The assistant is a bit busy — please try again in a moment.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('Chat API error:', err);
      return res.status(502).json({ error: 'The assistant is unavailable right now — please try again shortly.' });
    }
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
