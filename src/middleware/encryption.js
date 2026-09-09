// Transparent request/response payload obfuscation. When a client sends
// `X-Encrypted: 1` and the feature is enabled, the request body arrives as an
// { data: "<b64>" } envelope which we unwrap back into real JSON before any
// route sees it, and the JSON response goes back out as the same kind of
// envelope. (See payloadCrypto.js — this is obfuscation over TLS, not secrecy.)
//
// Clients that don't opt in (curl, health checks, the whatsapp-bot service)
// are untouched, so turning PAYLOAD_OBFUSCATION_ENABLED on is backwards-
// compatible.

const { isEnabled, encryptString, decryptString } = require('../lib/payloadCrypto');

const HEADER = 'x-encrypted';

function decryptRequest(req, res, next) {
  if (req.get(HEADER) !== '1') return next();

  if (!isEnabled()) {
    return res.status(400).json({ error: 'Encrypted transport is not enabled on this server.' });
  }

  // Remember the client wants its reply encrypted too (see encryptResponse).
  req.wantsEncryptedResponse = true;

  const envelope = req.body;
  if (envelope && typeof envelope.data === 'string') {
    try {
      const json = decryptString(envelope.data);
      req.body = json ? JSON.parse(json) : {};
    } catch {
      return res.status(400).json({ error: 'Could not decrypt request payload.' });
    }
  }
  next();
}

function encryptResponse(req, res, next) {
  if (!isEnabled()) return next();

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (!req.wantsEncryptedResponse) return sendJson(body);
    try {
      const data = encryptString(JSON.stringify(body === undefined ? null : body));
      res.set('X-Encrypted', '1');
      return sendJson({ data });
    } catch {
      res.status(500);
      return sendJson({ error: 'Response encryption failed.' });
    }
  };
  next();
}

module.exports = { decryptRequest, encryptResponse };
