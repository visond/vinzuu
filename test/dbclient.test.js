'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { retryingFetch } = require('../lib/dbclient');

const netError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
const quiet = (t) => t.mock.method(console, 'warn', () => {});

test('the Turso connection tries again after a dropped or timed-out connection', async (t) => {
  quiet(t);
  const bodies = [];
  let calls = 0;
  const fetchFn = retryingFetch(async (req) => {
    bodies.push(await req.text());
    calls++;
    if (calls === 1) throw netError('UND_ERR_SOCKET');
    if (calls === 2) throw netError('ETIMEDOUT');
    return new Response('ok');
  }, { delays: [1, 1] });
  const res = await fetchFn(new Request('https://db.example/v2/pipeline', { method: 'POST', body: '{"q":1}' }));
  assert.strictEqual(await res.text(), 'ok');
  assert.deepStrictEqual(bodies, ['{"q":1}', '{"q":1}', '{"q":1}'], 'every try sends the full request');
});

test('the Turso connection gives up after three tries, and never retries other errors', async (t) => {
  quiet(t);
  let calls = 0;
  const down = retryingFetch(async () => { calls++; throw netError('ECONNRESET'); }, { delays: [1, 1] });
  await assert.rejects(down(new Request('https://db.example/x')), /fetch failed/);
  assert.strictEqual(calls, 3);

  calls = 0;
  const broken = retryingFetch(async () => { calls++; throw new Error('bad token'); }, { delays: [1, 1] });
  await assert.rejects(broken(new Request('https://db.example/x')), /bad token/);
  assert.strictEqual(calls, 1);
});
