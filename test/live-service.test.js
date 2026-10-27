const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiveService, catalogFrom, publicError } = require('../src/live/live-service');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const threadId = '00000000-0000-7000-8000-000000000001';
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
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: threadId }, model: params.model };
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
  rpc.emit('notification', { method: 'thread/realtime/sdp', params: { threadId, sdp: 'answer' } });
  assert.deepEqual(events[0], { key: 'call-a', type: 'sdp', sdp: 'answer' });
  rpc.emit('request', { id: 4, method: 'item/commandExecution/requestApproval' });
  assert.deepEqual(rpc.lastSent, { id: 4, result: { decision: 'decline' } });
  rpc.emit('request', { id: 5, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'echo hi' } });
  assert.equal(events.at(-1).type, 'approval');
  f.service.respondApproval({ key: 'call-a', id: '5', approve: true });
  assert.deepEqual(rpc.lastSent, { id: 5, result: { decision: 'accept' } });
  await f.service.stop('stale-call'); assert.equal(f.service.call.key, 'call-a');
  await f.service.stop('call-a'); assert.equal(f.service.call, null);
  rpc.emit('notification', { method: 'thread/realtime/sdp', params: { threadId, sdp: 'late' } });
  assert.equal(events.filter(e => e.type === 'sdp').length, 1);
});
test('permission levels configure the server and pending approvals are denied on stop', async t => {
  const f = fixture(t);
  await f.service.start({ ...input('call-a'), permission: 'full' });
  const params = f.requests.find(r => r.method === 'thread/start').params;
  assert.equal(params.sandbox, 'danger-full-access'); assert.equal(params.approvalPolicy, 'never');
  const rpc = f.instances[0];
  rpc.emit('request', { id: 8, method: 'item/permissions/requestApproval', params: { threadId, permissions: { network: { enabled: true } } } });
  await f.service.stop('call-a');
  assert.deepEqual(rpc.lastSent, { id: 8, result: { permissions: {}, scope: 'turn' } });
  await f.service.start({ ...input('call-b'), permission: 'auto' });
  const resumed = f.requests.find(r => r.method === 'thread/resume').params;
  assert.equal(resumed.sandbox, 'workspace-write'); assert.equal(resumed.approvalPolicy, 'on-request');
});
test('approval details keep the full command and access paths after a long reason', async t => {
  const f = fixture(t), events = []; f.service.on('event', event => events.push(event));
  await f.service.start(input('call-a'));
  const params = {
    threadId, reason: 'Reason '.repeat(300) + 'reason-end',
    command: 'node script.js --output /home/alice/private/result.json',
    cwd: '/home/alice/project', grantRoot: '/home/bob/shared',
    networkApprovalContext: { host: 'api.example.test', protocol: 'https' },
  };
  f.instances[0].emit('request', { id: 20, method: 'item/commandExecution/requestApproval', params });
  const approval = events.at(-1);
  assert.equal(approval.type, 'approval');
  for (const value of [params.reason, params.command, params.cwd, params.grantRoot, params.networkApprovalContext.host]) {
    assert.ok(approval.detail.includes(value), 'approval must retain each complete requested value');
  }
  assert.equal(f.instances[0].lastSent, undefined, 'showing details must not approve the request');
  f.service.respondApproval({ key: 'call-a', id: approval.id, approve: false });
  assert.deepEqual(f.instances[0].lastSent, { id: 20, result: { decision: 'decline' } });
});
test('approval details retain long command tails and every requested permission before accepting', async t => {
  const f = fixture(t), events = []; f.service.on('event', event => events.push(event));
  await f.service.start(input('call-a'));
  const command = 'echo ' + 'argument '.repeat(400) + '; rm /home/alice/important.txt';
  const rpc = f.instances[0];
  rpc.emit('request', { id: 21, method: 'item/commandExecution/requestApproval', params: { threadId, command } });
  assert.ok(events.at(-1).detail.includes(command), 'the command tail must remain visible');
  f.service.respondApproval({ key: 'call-a', id: '21', approve: false });
  const permissions = { fileSystem: { write: Array.from({ length: 150 }, (_, i) => `/home/alice/project/directory-${i}`) }, network: { enabled: true } };
  rpc.emit('request', { id: 22, method: 'item/permissions/requestApproval', params: { threadId, permissions } });
  const detail = events.at(-1).detail;
  for (const requestedPath of permissions.fileSystem.write) assert.ok(detail.includes(requestedPath));
  assert.match(detail, /"network"\s*:\s*\{\s*"enabled"\s*:\s*true/);
  assert.deepEqual(rpc.lastSent, { id: 21, result: { decision: 'decline' } }, 'permissions wait for an explicit decision');
  f.service.respondApproval({ key: 'call-a', id: '22', approve: true });
  assert.deepEqual(rpc.lastSent, { id: 22, result: { permissions, scope: 'turn' } });
});
test('public errors still redact credentials and home paths and remain length-limited', () => {
  const message = 'Authorization: Bearer fixture-secret\n/home/alice/private\n' + 'detail '.repeat(300);
  const result = publicError(new Error(message));
  assert.equal(result.length, 1200);
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(result.includes('~/private'));
  assert.ok(!result.includes('fixture-secret'));
  assert.ok(!result.includes('/home/alice'));
});
test('a delayed text acknowledgement after stop cannot fail or write into a later call', async t => {
  const f = fixture(t); await f.service.start(input('call-a'));
  const originalCall = f.service.call, gate = deferred(); f.gates.set('thread/realtime/appendText', gate);
  const sending = f.service.text({ key: 'call-a', text: 'message from the old call' });
  await f.service.stop('call-a');
  await f.service.start(input('call-b'));
  const nextCall = f.service.call;
  gate.resolve(); await sending;
  assert.equal(f.service.call, nextCall);
  assert.deepEqual(nextCall.record.messages, []);
  assert.deepEqual(originalCall.record.messages, []);
  assert.deepEqual(f.service.history.read(threadId).messages, []);
});
test('a delayed text acknowledgement after dispose does not access a cleared call', async t => {
  const f = fixture(t); await f.service.start(input('call-a'));
  const gate = deferred(); f.gates.set('thread/realtime/appendText', gate);
  const sending = f.service.text({ key: 'call-a', text: 'message before dispose' });
  f.service.dispose(); gate.resolve(); await sending;
  assert.equal(f.service.call, null);
});
test('failed realtime start declines pending approvals before the next call', async t => {
  const f = fixture(t); await f.service.prepare();
  const rpc = f.instances[0], gate = deferred(), request = rpc.request.bind(rpc), replies = [];
  rpc.send = message => replies.push(message);
  rpc.request = async (method, params) => {
    if (method === 'thread/realtime/start') { await gate.promise; throw new Error('fixture start failure'); }
    return request(method, params);
  };
  const starting = f.service.start(input('call-a'));
  const rejected = assert.rejects(starting, /fixture start failure/);
  while (!f.service.call?.threadId) await new Promise(resolve => setImmediate(resolve));
  rpc.emit('request', { id: 30, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'echo fixture' } });
  rpc.emit('request', { id: 31, method: 'item/permissions/requestApproval', params: { threadId, permissions: { network: { enabled: true } } } });
  gate.resolve(); await rejected;
  assert.equal(f.service.call, null); assert.equal(f.service.approvals.size, 0);
  assert.deepEqual(replies, [
    { id: 30, result: { decision: 'decline' } },
    { id: 31, result: { permissions: {}, scope: 'turn' } },
  ]);
  rpc.request = request;
  await f.service.start(input('call-b'));
  assert.throws(() => f.service.respondApproval({ key: 'call-b', id: '30', approve: true }), /만료/);
  assert.equal(replies.length, 2);
});
test('completed transcripts survive reconnection and are supplied when continuing a selected conversation', async t => {
  const f = fixture(t), cwd = f.service.root;
  await f.service.start({ ...input('call-a'), workspace: cwd });
  f.instances[0].emit('notification', { method: 'thread/realtime/transcript/done', params: { threadId, role: 'user', text: 'Earlier question' } });
  f.instances[0].emit('notification', { method: 'thread/realtime/transcript/done', params: { threadId, role: 'assistant', text: 'Earlier answer' } });
  await f.service.stop('call-a');
  assert.equal((await f.service.listHistory())[0].title, 'Earlier question');
  f.service.resetConnection();
  const selected = await f.service.selectHistory(threadId);
  assert.equal(selected.messages.length, 2);
  await f.service.start({ ...input('call-b'), workspace: cwd });
  assert.equal(f.requests.at(-2).method, 'thread/resume');
  assert.match(f.requests.at(-1).params.prompt, /Earlier question[\s\S]*Earlier answer/);
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
