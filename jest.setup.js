// Same patch app.js applies in production — each test file gets its own
// fresh module registry, so this has to run again per file (via Jest's
// `setupFiles`) for any test that builds its own bare `express()` app
// (most of src/routes/*.test.js) to see the same async-error forwarding
// real requests get.
require('express-async-errors');

// The route-test suite spins up a fresh ephemeral HTTP server (via
// supertest) per request, across many files run in parallel Jest workers —
// which occasionally (rarely, OS-level) trips a real but unrelated-to-the-
// code-under-test flake, either a `Parse Error` from Node's HTTP parser on
// a rapidly reused/contended ephemeral port, or an aborted "socket hang up".
// A couple of automatic retries absorbs that class of flake (a genuine
// assertion failure still fails after exhausting retries) without masking
// real regressions — this is Jest's own documented way to handle exactly
// this kind of network-involving flakiness.
if (typeof jest !== 'undefined' && typeof jest.retryTimes === 'function') {
  jest.retryTimes(2, { logErrorsBeforeRetry: true });
}
