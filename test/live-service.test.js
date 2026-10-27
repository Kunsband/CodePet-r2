const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiveService, catalogFrom } = require('../src/live/live-service');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const input = key => ({ key, model: 'server-model', voice: 'server-voice', sdp: 'v=0\r\ns=fixture\r\n' });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepet-live-'));
  let account = { hasAuth: true, accountId: 'account-a', homePath: root, label: 'Account' };
  const requests = [], instances = [], gates = new Map(); let finished = 0;
  class Rpc extends EventEmitter {
    async initialize() {}
    async request(method, params) {
      requests.push({ method, params });
      if (gates.has(method)) await gates.get(method).promise;
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: { model: 'server-model' } };
      if (method === 'thread/realtime/listVoices') return { voices: { v3: ['server-voice'], defaultV1: 'server-voice' } };
      if (method === 'model/list') return { data: [{ model: 'server-model', displayName: 'Server model', isDefault: true }] };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-' + instances.length }, model: params.model };
      return {};
    }
    send(message) { this.lastSent = message; }
    close() { this.closed = true; this.emit('closed', new Error('closed')); }
  }
  const service = new LiveService({ root, getAccount: () => account,
    runtime: { prepare: () => ({ home: root, env: {}, argv: [], finish: () => { finished++; } }) },
    resolveCommand: async () => ({ command: 'fixture' }), makeRpc: () => { const rpc = new Rpc(); instances.push(rpc); return rpc; },
  });
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, requests, instances, gates, setAccount: value => { account = value; }, getFinished: () => finished };
}
test('catalog uses provider results and configuration without inventing languages or models', () => {
  const catalog = catalogFrom([{ model: 'new-server-model', displayName: 'New server model' }, { model: 'hidden', hidden: true }],
    { voices: { v3: ['new-voice', 'new-voice'] } }, { model: 'removed-model' });
  assert.deepEqual(catalog.models.map(m => m.id), ['new-server-model']);
  assert.equal(catalog.defaultModel, 'new-server-model');
  assert.deepEqual(catalog.voices.map(v => v.id), ['new-voice']);
  assert.deepEqual(catalog.language, { selectable: false, source: 'conversation' });
  assert.equal(catalog.realtimeModel, null);
  assert.throws(() => catalogFrom([], { voices: { v3: ['voice'] } }));
});
test('refresh and account change query new capabilities and dispose the old runtime', async t => {
  const f = fixture(t);
  await f.service.prepare(); await f.service.prepare(); assert.equal(f.instances.length, 1);
  await f.service.prepare(true); assert.equal(f.instances.length, 2); assert.equal(f.getFinished(), 1);
  f.setAccount({ hasAuth: true, accountId: 'account-b', homePath: f.service.root });
  await f.service.prepare(); assert.equal(f.instances.length, 3); assert.equal(f.instances[1].closed, true);
});
test('start validates actual selections, forwards SDP and limits untrusted permissions', async t => {
  const f = fixture(t), events = []; f.service.on('event', event => events.push(event));
  await assert.rejects(f.service.start({ ...input('bad'), model: 'invented' }), /다시 선택/);
  await f.service.start(input('call-a'));
  const start = f.requests.find(r => r.method === 'thread/realtime/start');
  assert.equal(start.params.transport.sdp, input('call-a').sdp);
  assert.equal(start.params.voice, 'server-voice'); assert.equal(start.params.model, undefined);
  assert.equal(f.requests.find(r => r.method === 'thread/start').params.sandbox, 'workspace-write');
  const rpc = f.instances[0];
  rpc.emit('notification', { method: 'thread/realtime/sdp', params: { threadId: 'unrelated', sdp: 'ignored' } });
  assert.equal(events.length, 0);
  rpc.emit('notification', { method: 'thread/realtime/sdp', params: { threadId: 'thread-1', sdp: 'answer' } });
  assert.deepEqual(events[0], { key: 'call-a', type: 'sdp', sdp: 'answer' });
  rpc.emit('request', { id: 4, method: 'item/commandExecution/requestApproval' });
  assert.deepEqual(rpc.lastSent, { id: 4, result: { decision: 'decline' } });
  rpc.emit('request', { id: 5, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'echo hi' } });
  assert.equal(events.at(-1).type, 'approval');
  f.service.respondApproval({ key: 'call-a', id: '5', approve: true });
  assert.deepEqual(rpc.lastSent, { id: 5, result: { decision: 'accept' } });
  await f.service.stop('stale-call'); assert.equal(f.service.call.key, 'call-a');
  await f.service.stop('call-a'); assert.equal(f.service.call, null);
  rpc.emit('notification', { method: 'thread/realtime/sdp', params: { threadId: 'thread-1', sdp: 'late' } });
  assert.equal(events.filter(e => e.type === 'sdp').length, 1);
});
test('permission levels configure the server and pending approvals are denied on stop', async t => {
  const f = fixture(t);
  await f.service.start({ ...input('call-a'), permission: 'full' });
  const params = f.requests.find(r => r.method === 'thread/start').params;
  assert.equal(params.sandbox, 'danger-full-access'); assert.equal(params.approvalPolicy, 'never');
  const rpc = f.instances[0];
  rpc.emit('request', { id: 8, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', permissions: { network: { enabled: true } } } });
  await f.service.stop('call-a');
  assert.deepEqual(rpc.lastSent, { id: 8, result: { permissions: {}, scope: 'turn' } });
  await f.service.start({ ...input('call-b'), permission: 'auto' });
  const resumed = f.requests.find(r => r.method === 'thread/resume').params;
  assert.equal(resumed.sandbox, 'workspace-write'); assert.equal(resumed.approvalPolicy, 'on-request');
});
test('a changed workspace starts a fresh thread with the selected directory', async t => {
  const f = fixture(t), first = path.join(f.service.root, 'first'), second = path.join(f.service.root, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  await f.service.start({ ...input('call-a'), workspace: first });
  await f.service.stop('call-a');
  await f.service.start({ ...input('call-b'), workspace: second });
  const starts = f.requests.filter(r => r.method === 'thread/start');
  assert.deepEqual(starts.map(r => r.params.cwd), [first, second]);
  assert.equal(f.requests.some(r => r.method === 'thread/resume'), false);
});
test('cancel during capability loading prevents a voice session from starting', async t => {
  const f = fixture(t), gate = deferred(); f.gates.set('model/list', gate);
  const starting = f.service.start(input('call-a'));
  const rejected = assert.rejects(starting, /취소/);
  const stopped = f.service.stop('call-a'); gate.resolve(); await Promise.all([rejected, stopped]);
  assert.equal(f.requests.some(r => r.method === 'thread/realtime/start'), false);
});
test('cancel during realtime negotiation stops the late session and rejects concurrent starts', async t => {
  const f = fixture(t), gate = deferred(); f.gates.set('thread/realtime/start', gate);
  await f.service.prepare();
  const starting = f.service.start(input('call-a'));
  const rejected = assert.rejects(starting, /취소/);
  while (!f.requests.some(r => r.method === 'thread/realtime/start')) await new Promise(r => setImmediate(r));
  await assert.rejects(f.service.start(input('call-b')), /진행 중/);
  const stopped = f.service.stop('call-a'); gate.resolve(); await Promise.all([rejected, stopped]);
  assert.equal(f.requests.filter(r => r.method === 'thread/realtime/stop').length, 1);
  assert.equal(f.service.call, null);
});
test('reconnect waits for the previous stop and old keys cannot append text', async t => {
  const f = fixture(t); await f.service.start(input('call-a'));
  const gate = deferred(); f.gates.set('thread/realtime/stop', gate);
  const stopping = f.service.stop('call-a'), next = f.service.start(input('call-b'));
  await new Promise(r => setImmediate(r));
  assert.equal(f.requests.filter(r => r.method === 'thread/realtime/start').length, 1);
  gate.resolve(); await Promise.all([stopping, next]);
  await assert.rejects(f.service.text({ key: 'call-a', text: 'stale' }), /종료/);
  await assert.rejects(f.service.text({ key: 'call-b', text: 'x'.repeat(8001) }), /8,000/);
  await f.service.text({ key: 'call-b', text: ' hello ' });
  assert.equal(f.requests.at(-1).params.text, 'hello');
});
test('dispose during command resolution cancels and finalizes its private auth runtime', async t => {
  const f = fixture(t), gate = deferred(); f.service.resolveCommand = () => gate.promise;
  const preparing = f.service.prepare(); const rejected = assert.rejects(preparing, /취소/);
  f.service.dispose(); gate.resolve({ command: 'fixture' }); await rejected;
  assert.equal(f.instances.length, 0); assert.equal(f.getFinished(), 1);
});
