const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { killTree } = require('../src/chat/chat-agent-runner');

test('Windows cancellation preserves the parent until taskkill has terminated the tree', () => {
  let directKills = 0;
  const child = { pid: 123, killed: false, exitCode: null, kill() { directKills++; } };
  const killer = new EventEmitter();
  killTree(child, 'win32', (command, args, options) => {
    assert.equal(command, 'taskkill');
    assert.deepEqual(args, ['/pid', '123', '/T', '/F']);
    assert.equal(options.windowsHide, true);
    return killer;
  });
  assert.equal(directKills, 0);
  killer.emit('close', 0);
  assert.equal(directKills, 0);
});

test('Windows cancellation falls back if taskkill cannot start or fails', () => {
  for (const event of ['error', 'close']) {
    let directKills = 0;
    const child = { pid: 123, killed: false, exitCode: null, kill() { directKills++; } };
    const killer = new EventEmitter();
    killTree(child, 'win32', () => killer);
    killer.emit(event, event === 'error' ? new Error('fixture') : 1);
    assert.equal(directKills, 1);
  }
});
