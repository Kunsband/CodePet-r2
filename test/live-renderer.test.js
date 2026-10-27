const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture() {
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.events = {}; this.attributes = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.style = { setProperty() {}, removeProperty() {} }; }
    addEventListener(name, handler) { this.events[name] = handler; }
    dispatch(name) { return this.events[name]?.({ preventDefault() {} }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelector() { return new Element(); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    get lastElementChild() { return this.children.at(-1); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    pause() {}
  }
  const elements = new Map(), host = new Element(), peers = [], textGate = deferred();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const track = { stop() {}, addEventListener() {} }, stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const audioNode = () => ({ connect() {}, gain: {}, fftSize: 256, getByteTimeDomainData: data => data.fill(128) });
  let historyLists = 0, key = 0;
  const liveApi = {
    catalog: async () => ({ ok: true, data: { models: [{ id: 'model' }], voices: [{ id: 'voice' }], defaultModel: 'model', defaultVoice: 'voice', workspace: '/fixture' } }),
    historyList: async () => { historyLists++; return { ok: true, data: [{ id: 'other', title: 'Other conversation', updatedAt: 1 }] }; },
    historySelect: async () => ({ ok: true, data: { cwd: '/other', messages: [{ role: 'assistant', text: 'Other conversation content' }] } }),
    start: async () => ({ ok: true, data: { threadId: 'fixture-thread' } }),
    stop: async () => ({ ok: true }), text: () => textGate.promise,
    onEvent() {}, onAppearance() {}, onMaximized() {},
  };
  class Peer {
    constructor() { this.iceGatheringState = 'complete'; peers.push(this); }
    addTrack() {} close() {} createDataChannel() { return {}; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\ns=fixture' }; }
    async setLocalDescription(value) { this.localDescription = value; }
  }
  class Audio {
    async resume() {} async close() {}
    createMediaStreamSource() { return audioNode(); }
    createAnalyser() { return audioNode(); }
    createGain() { return audioNode(); }
  }
  // Run the actual renderer with synthetic DOM, IPC, media and timers. No devices or network.
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/live.js'), 'utf8'), {
    document: { getElementById: get, querySelector: () => host, documentElement: new Element(), createElement: () => new Element(), createTextNode: text => ({ textContent: text }) },
    window: { innerWidth: 760, addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    Option: class extends Element {}, liveApi, AudioContext: Audio, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { getUserMedia: async () => stream } }, crypto: { randomUUID: () => `call-${++key}` },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  });
  await tick();
  const start = async () => {
    await get('call').dispatch('click');
    const peer = peers.at(-1); peer.connectionState = 'connected'; peer.onconnectionstatechange();
    assert.equal(get('message').disabled, false);
  };
  await start();
  return { get, start, textGate, historyLists: () => historyLists,
    send: text => { get('message').value = text; return get('message-form').dispatch('submit'); },
    selectOther: async () => { get('history-list').children[0].children[0].dispatch('click'); await tick(); },
    messages: () => get('history-messages').children.map(child => child.dataset.text),
  };
}

test('late text success cannot append to another conversation or clear its input', async () => {
  const f = await fixture(), sending = f.send('same text');
  await f.selectOther(); await f.start();
  f.get('message').value = 'same text';
  const requests = f.historyLists();
  f.textGate.resolve({ ok: true }); await sending;
  assert.deepEqual(f.messages(), ['Other conversation content']);
  assert.equal(f.get('message').value, 'same text');
  assert.equal(f.historyLists(), requests);
  assert.equal(f.get('send').disabled, false);
});

test('late text failure cannot show an error in a newly selected conversation', async () => {
  const f = await fixture(), sending = f.send('old message');
  await f.selectOther();
  f.textGate.resolve({ ok: false, error: 'old call failed' }); await sending;
  assert.equal(f.get('error').hidden, true);
  assert.equal(f.get('error').textContent, '');
  assert.deepEqual(f.messages(), ['Other conversation content']);
});

test('text success in the current call appends once, clears its input and refreshes history', async () => {
  const f = await fixture(), requests = f.historyLists(), sending = f.send('current message');
  f.textGate.resolve({ ok: true }); await sending;
  assert.deepEqual(f.messages(), ['current message']);
  assert.equal(f.get('message').value, '');
  assert.equal(f.historyLists(), requests + 1);
});

test('text failure in the current call preserves the input and allows retry', async () => {
  const f = await fixture(), sending = f.send('current message');
  f.textGate.resolve({ ok: false, error: 'current call failed' }); await sending;
  assert.equal(f.get('error').textContent, 'current call failed');
  assert.equal(f.get('error').hidden, false);
  assert.equal(f.get('message').value, 'current message');
  assert.equal(f.get('send').disabled, false);
  assert.deepEqual(f.messages(), []);
});
