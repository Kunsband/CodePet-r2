// Run with node scripts/smoke-live-delete.js. Uses an isolated Codex home and no model turns.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexLiveRpc, resolveCodexCommand } = require('../src/live/codex-live-rpc');
const { LiveService } = require('../src/live/live-service');
const { LiveHistory } = require('../src/live/live-history');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepet-live-delete-'));
  const env = { ...process.env, CODEX_HOME: root };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.OPENAI_BASE_URL;
  const rpc = new CodexLiveRpc({ ...await resolveCodexCommand(), cwd: root, env });
  try {
    await rpc.initialize();
    const { thread } = await rpc.request('thread/start', { cwd: root, ephemeral: false, sandbox: 'read-only', approvalPolicy: 'untrusted' });
    const service = new LiveService({ root, getAccount: () => ({}) });
    // Exercise the real deletion method without loading any account or requesting a voice/model session.
    service.prepare = async () => ({});
    service.rpc = rpc; service.history = new LiveHistory(root); service.thread = thread.id;
    service.history.write({ id: thread.id, cwd: root, messages: [{ role: 'user', text: 'Synthetic deletion check' }] });
    assert.equal((await service.deleteHistory(thread.id)).active, true);
    for (const archived of [false, true]) {
      const list = await rpc.request('thread/list', { archived, limit: 100 });
      assert.equal(list.data.some(item => item.id === thread.id), false);
    }
    assert.deepEqual(await service.listHistory(), []);
    await assert.rejects(rpc.request('thread/read', { threadId: thread.id }));
    assert.deepEqual(service.history.read(thread.id).messages, []);
    console.log('Live deletion passed against installed Codex with synthetic data.');
  } finally { rpc.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
