const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexLiveRpc } = require('../src/live/codex-live-rpc');
function fixture(t) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => {}; const sent = [];
  child.stdin.on('data', line => sent.push(JSON.parse(line)));
  const rpc = new CodexLiveRpc({ command: 'fixture', spawnProcess: () => child, timeout: 1000 });
  t.after(() => rpc.close());
  return { rpc, child, sent };
}
test('RPC handles chunked JSONL, unsolicited notifications, server requests and errors', async t => {
  const { rpc, child, sent } = fixture(t), notices = [], requests = [];
  rpc.on('notification', m => notices.push(m)); rpc.on('request', m => requests.push(m));
  const first = rpc.request('first'), second = rpc.request('second');
  const rejected = assert.rejects(second, { message: 'server failure', code: -1 });
  child.stdout.write('noise\nnull\n{"id":' + sent[0].id);
  child.stdout.write(',"result":{"ready":true}}\n' + JSON.stringify({ id: sent[1].id, error: { message: 'server failure', code: -1 } }) + '\n');
  child.stdout.write('{"method":"notice","params":{}}\n{"id":33,"method":"approval"}\n');
  assert.deepEqual(await first, { ready: true }); await rejected;
  assert.equal(notices[0].method, 'notice'); assert.equal(requests[0].id, 33);
  assert.equal(rpc.pending.size, 0);
});
test('RPC timeout removes the request and process exit rejects every pending request', async t => {
  const { rpc, child } = fixture(t);
  // Keep the test alive while the client unrefs its timeout.
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(rpc.request('slow', {}, 5), /초과/); assert.equal(rpc.pending.size, 0);
  const pending = rpc.request('pending'); const rejected = assert.rejects(pending, /종료/);
  child.emit('close', 1); await rejected; assert.equal(rpc.closed, true);
  await assert.rejects(rpc.request('after-close'), /종료/);
});
