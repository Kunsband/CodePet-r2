const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { killTree, quoteArgForShell } = require('../chat/chat-agent-runner');
const { selectCommandPath, commandNeedsShell } = require('../command-resolution');

async function resolveCodexCommand() {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { windowsHide: true, timeout: 5000 });
  let command = selectCommandPath(stdout);
  if (!command) throw new Error('Codex CLI를 찾지 못했습니다. 설정에서 Codex 설치 상태를 확인해 주세요.');
  if (process.platform === 'win32' && commandNeedsShell(command)) {
    // Resolve the native executable belonging to this npm shim, not another PATH installation.
    const entry = path.join(path.dirname(command), 'node_modules', '@openai', 'codex', 'package.json');
    if (fs.existsSync(entry)) {
      try {
        const pkg = createRequire(entry).resolve(`@openai/codex-win32-${process.arch}/package.json`);
        const triple = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
        const native = path.join(path.dirname(pkg), 'vendor', `${triple}-pc-windows-msvc`, 'bin', 'codex.exe');
        if (fs.existsSync(native)) command = native;
      } catch {}
    }
  }
  return { command, needsShell: commandNeedsShell(command) };
}

class CodexLiveRpc extends EventEmitter {
  constructor({ command, needsShell, env, cwd, argv = [], spawnProcess = spawn, timeout = 30000 }) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.timeout = timeout;
    this.closed = false;
    const args = ['app-server', '--listen', 'stdio://', ...argv];
    this.child = spawnProcess(needsShell ? `"${command}"` : command, needsShell ? args.map(arg => quoteArgForShell(arg)) : args, {
      shell: Boolean(needsShell), env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return this.fail(new Error('Codex 응답이 허용 크기를 초과했습니다.'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
        if (message.method && message.id !== undefined) this.emit('request', message);
        else if (message.method) this.emit('notification', message);
        else if (this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) {
            const error = new Error(message.error.message || 'Codex 요청에 실패했습니다.');
            error.code = message.error.code; pending.reject(error);
          } else pending.resolve(message.result);
        }
      }
    });
    // Drain stderr without logging account/configuration data.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', () => this.fail(new Error('Codex 연결이 종료되었습니다.')));
  }
  send(message) {
    if (this.closed) throw new Error('Codex 연결이 종료되었습니다.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = this.timeout) {
    if (this.closed) return Promise.reject(new Error('Codex 연결이 종료되었습니다.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 응답 시간이 초과되었습니다: ${method}`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'codepet_live', title: 'CodePet Live', version: require('../../package.json').version },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
    try { killTree(this.child); this.child.stdin.end(); } catch {}
  }
  close() { this.fail(new Error('Codex 연결을 닫았습니다.')); }
}

module.exports = { CodexLiveRpc, resolveCodexCommand };
