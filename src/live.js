/* global liveApi */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const host = document.querySelector('.live-window');
  let catalog = null, current = null, loading = false, ending = false, settingsBusy = false, selection = {};
  try { selection = JSON.parse(localStorage.getItem('codepet.live.selection') || '{}'); } catch {}
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) selection = {};
  const permissions = { ask: '명령과 작업에 대해 승인을 요청합니다.', auto: '일반 작업은 자동으로 진행하고 추가 권한이 필요하면 승인을 요청합니다.', full: '컴퓨터의 파일과 인터넷에 제한 없이 접근합니다.' };
  if (!Object.hasOwn(permissions, selection.permission)) selection.permission = 'ask';
  let approvalQueue = [], workspace = '', activeThread = null, historyRequest = 0;
  if (window.innerWidth <= 600) host.dataset.sidebar = 'closed';
  function sidebar(open) { host.dataset.sidebar = open ? 'open' : 'closed'; $('history-open').setAttribute('aria-expanded', String(open)); }
  sidebar(host.dataset.sidebar === 'open');
  function showWorkspace(value) {
    workspace = value;
    $('workspace').textContent = value;
    $('project-path').textContent = value;
    $('project-open').title = value;
  }
  function showApproval() {
    if (!approvalQueue.length || !current) { if ($('approval').open) $('approval').close(); return; }
    $('approval-detail').textContent = approvalQueue[0].detail;
    $('approval-accept').disabled = approvalQueue[0].canApprove === false;
    if (!$('approval').open) $('approval').showModal();
  }
  const valueOf = async promise => {
    const result = await promise;
    if (!result?.ok) throw new Error(result?.error || '요청을 처리하지 못했습니다.');
    return result.data;
  };
  function setError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
  function status(text, state) {
    if ($('status').textContent !== text) $('status').textContent = text;
    if (state && host.dataset.state !== state) host.dataset.state = state;
  }
  function update() {
    const connected = !!current?.connected;
    $('call').disabled = !current && (loading || ending || !catalog);
    $('call').setAttribute('aria-label', current ? '음성 대화 종료' : '음성 대화 시작');
    $('call').querySelector('use').setAttribute('href', current ? '#i-close' : '#i-play');
    $('mute').disabled = !connected;
    $('mute').setAttribute('aria-pressed', String(!!current?.muted));
    $('mute').setAttribute('aria-label', current?.muted ? '마이크 켜기' : '마이크 끄기');
    $('mute').querySelector('use').setAttribute('href', current?.muted ? '#i-mute' : '#i-mic');
    $('message').disabled = !connected;
    $('send').disabled = !connected || !!current?.sending || !$('message').value.trim();
    $('settings-apply').disabled = !catalog || loading || settingsBusy;
    $('reload-catalog').disabled = !!current || loading || ending;
    $('model').disabled = !catalog || loading;
    $('voice').disabled = !catalog || loading;
    $('voice-summary').textContent = selection.voice || '음성 설정';
  }
  function appearance(data) {
    host.dataset.mode = data?.workMode ? 'office' : 'character';
    const font = typeof data?.fontFamily === 'string' ? data.fontFamily.replace(/["\\\n\r]/g, '') : '';
    if (font) {
      document.documentElement.style.setProperty('--user-font', `"${font}"`);
      document.documentElement.style.setProperty('--font-display', `"${font}"`);
    } else {
      document.documentElement.style.removeProperty('--user-font');
      document.documentElement.style.removeProperty('--font-display');
    }
  }
  async function loadCatalog(refresh = false) {
    if (loading || current || ending) return;
    loading = true; setError(); status('연결 정보를 확인하는 중…', 'idle'); update();
    try {
      catalog = await valueOf(liveApi.catalog(refresh));
      showWorkspace(catalog.workspace);
      if (!catalog.models.some(m => m.id === selection.model)) selection.model = catalog.defaultModel;
      if (!catalog.voices.some(v => v.id === selection.voice)) selection.voice = catalog.defaultVoice;
      $('model').replaceChildren(...catalog.models.map(model => new Option(model.label, model.id)));
      $('voice').replaceChildren(...catalog.voices.map(voice => new Option(voice.label, voice.id)));
      $('model').value = selection.model; $('voice').value = selection.voice;
      $('account-label').textContent = catalog.accountLabel;
      $('realtime-model').textContent = catalog.realtimeModel || '서버 기본값';
      appearance(catalog.appearance);
      await refreshHistory();
      status('음성 대화를 시작해 보세요', 'idle');
    } catch (error) { catalog = null; setError(error.message); status('연결 정보를 불러오지 못했어요', 'idle'); }
    finally { loading = false; update(); }
  }
  function cleanup(session) {
    clearTimeout(session.timeout); clearTimeout(session.disconnectTimeout);
    cancelAnimationFrame(session.frame);
    session.stream?.getTracks().forEach(track => track.stop());
    session.pc?.close(); session.context?.close().catch(() => {});
    $('remote-audio').pause(); $('remote-audio').srcObject = null;
    host.style.removeProperty('--audio-scale');
  }
  async function end(message = '음성 대화가 종료됐어요') {
    const previous = current; current = null;
    approvalQueue = []; showApproval();
    if (previous) cleanup(previous);
    if (previous) ending = true;
    status(message, 'ended'); update();
    if (previous) {
      try { await liveApi.stop(previous.key); } catch {}
      finally { ending = false; update(); }
    }
  }
  async function fail(session, error) {
    if (current !== session) return;
    const message = error?.name === 'NotAllowedError' ? '마이크 사용이 허용되지 않았습니다. 운영체제의 마이크 권한을 확인해 주세요.'
      : error?.name === 'NotFoundError' ? '사용 가능한 마이크가 없습니다.' : error.message || '음성 연결에 실패했습니다.';
    setError(message); await end('다시 연결해 주세요');
  }
  function analyser(session, stream) {
    const source = session.context.createMediaStreamSource(stream);
    const node = session.context.createAnalyser(); node.fftSize = 256;
    const silent = session.context.createGain(); silent.gain.value = 0;
    source.connect(node); node.connect(silent); silent.connect(session.context.destination);
    return { node, buffer: new Uint8Array(node.fftSize) };
  }
  function level(entry) {
    if (!entry) return 0;
    entry.node.getByteTimeDomainData(entry.buffer);
    let sum = 0;
    for (const value of entry.buffer) sum += ((value - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / entry.buffer.length) * 5);
  }
  function animate(session) {
    if (current !== session) return;
    const input = session.muted ? 0 : level(session.input), output = level(session.output);
    host.style.setProperty('--audio-scale', String(1 + Math.max(input, output) * .16));
    if (session.connected) status(output > .06 ? '말하고 있어요' : session.muted ? '마이크가 꺼져 있어요' : '듣고 있어요', output > .06 ? 'speaking' : 'listening');
    session.frame = requestAnimationFrame(() => animate(session));
  }
  function metadata(data) {
    const session = data?.session;
    if (!session) return;
    if (typeof session.model === 'string') $('realtime-model').textContent = session.model;
    const language = session.audio?.input?.transcription?.language || session.input_audio_transcription?.language;
    if (typeof language === 'string' && language) {
      try { $('language').textContent = new Intl.DisplayNames([navigator.language], { type: 'language' }).of(language); }
      catch { $('language').textContent = language; }
    }
  }
  async function start() {
    if (current || !catalog || loading || ending) return;
    setError();
    $('caption-user').textContent = ''; $('caption-assistant').textContent = '';
    $('language').textContent = '말하는 언어에 맞춤';
    $('realtime-model').textContent = '서버 기본값';
    const session = { key: crypto.randomUUID(), muted: false, connected: false, captionsDone: {} };
    current = session; status('마이크와 연결을 준비하는 중…', 'connecting'); update();
    session.timeout = setTimeout(() => fail(session, new Error('음성 연결 시간이 초과되었습니다. 다시 시도해 주세요.')), 45000);
    try {
      session.context = new AudioContext(); await session.context.resume();
      if (current !== session) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current !== session) { stream.getTracks().forEach(track => track.stop()); return; }
      session.stream = stream; session.input = analyser(session, stream);
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => fail(session, new Error('마이크 연결이 종료되었습니다.'))));
      const pc = new RTCPeerConnection(); session.pc = pc;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.ontrack = async event => {
        if (current !== session) return;
        const remote = event.streams[0] || new MediaStream([event.track]);
        $('remote-audio').srcObject = remote; session.output = analyser(session, remote);
        try { await $('remote-audio').play(); } catch (error) { void fail(session, new Error('스피커 재생을 시작하지 못했습니다. 다시 연결해 주세요.')); }
      };
      pc.onconnectionstatechange = () => {
        if (current !== session) return;
        clearTimeout(session.disconnectTimeout);
        if (pc.connectionState === 'connected') { clearTimeout(session.timeout); session.connected = true; update(); }
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void fail(session, new Error('음성 연결이 끊겼습니다.'));
        else if (pc.connectionState === 'disconnected') session.disconnectTimeout = setTimeout(() => fail(session, new Error('음성 연결이 끊겼습니다.')), 10000);
      };
      const channel = pc.createDataChannel('oai-events');
      channel.onmessage = event => {
        if (current !== session || typeof event.data !== 'string' || event.data.length > 262144) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'session.created' || data.type === 'session.updated') metadata(data);
          if (data.type === 'error') void fail(session, new Error('음성 서버가 연결 오류를 반환했습니다.'));
        } catch {}
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve(); };
        const changed = () => { if (pc.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, 2000); pc.addEventListener('icegatheringstatechange', changed);
      });
      if (current !== session) return;
      animate(session);
      const started = await valueOf(liveApi.start({ key: session.key, model: selection.model, voice: selection.voice, permission: selection.permission, sdp: pc.localDescription.sdp }));
      activeThread = started.threadId;
      await refreshHistory();
      if (current !== session) await liveApi.stop(session.key);
    } catch (error) { await fail(session, error); }
  }
  liveApi.onEvent(async event => {
    if (event.type === 'suspended') { await end('다시 연결해 주세요'); return; }
    const session = current;
    if (!session || event.key !== session.key) return;
    try {
      if (event.type === 'sdp') await session.pc.setRemoteDescription({ type: 'answer', sdp: event.sdp });
      else if (event.type === 'error') await fail(session, new Error(event.message));
      else if (event.type === 'closed') await end();
      else if (event.type === 'notice') setError(event.message);
      else if (event.type === 'approval') { approvalQueue.push(event); showApproval(); }
      else if (event.type === 'transcript' && ['user','assistant'].includes(event.role)) {
        const caption = $('caption-' + event.role);
        if (event.done || session.captionsDone[event.role]) caption.textContent = '';
        caption.textContent = (caption.textContent + event.text).slice(-1600);
        session.captionsDone[event.role] = event.done;
        if (event.done && event.text.trim()) { appendHistoryMessage({ role: event.role, text: event.text }); void refreshHistory(); }
      }
    } catch (error) { await fail(session, error); }
  });
  liveApi.onAppearance(appearance);
  liveApi.onMaximized(maximized => $('maximize').setAttribute('aria-label', maximized ? '이전 크기로' : '최대화'));
  for (const action of ['minimize','maximize','close']) $(action).addEventListener('click', () => liveApi.window(action));
  $('call').addEventListener('click', () => current ? end() : start());
  $('mute').addEventListener('click', () => {
    if (!current?.stream) return;
    current.muted = !current.muted;
    current.stream.getAudioTracks().forEach(track => { track.enabled = !current.muted; }); update();
  });
  $('message').addEventListener('input', update);
  $('message-form').addEventListener('submit', async event => {
    event.preventDefault(); const session = current, text = $('message').value.trim();
    if (!session?.connected || session.sending || !text) return;
    session.sending = true; update();
    try {
      await valueOf(liveApi.text(session.key, text));
      if (current !== session) return;
      if ($('message').value.trim() === text) $('message').value = '';
      appendHistoryMessage({ role: 'user', text }); void refreshHistory();
    } catch (error) { if (current === session) setError(error.message); }
    finally { session.sending = false; update(); }
  });
  function appendHistoryMessage(message) {
    const last = $('history-messages').lastElementChild;
    if (last?.dataset.role === message.role && last.dataset.text === message.text) return;
    const p = document.createElement('p'), strong = document.createElement('strong');
    p.dataset.role = message.role; p.dataset.text = message.text;
    strong.textContent = message.role === 'user' ? '나' : 'Live';
    p.append(strong, document.createElement('br'), document.createTextNode(message.text));
    $('history-messages').append(p); $('history-messages').hidden = false;
    $('history-messages').scrollTop = $('history-messages').scrollHeight;
  }
  async function selectHistory(id) {
    if (current) await end();
    const result = await valueOf(liveApi.historySelect(id));
    if (result.cwd) showWorkspace(result.cwd);
    activeThread = id;
    $('caption-user').textContent = ''; $('caption-assistant').textContent = '';
    $('history-messages').replaceChildren(); $('history-messages').hidden = true;
    for (const message of result.messages || []) appendHistoryMessage(message);
    status(id ? '선택한 대화를 이어갈 수 있어요' : '새 대화를 시작해 보세요', 'idle');
    if (window.innerWidth <= 600) sidebar(false);
    await refreshHistory();
  }
  async function refreshHistory() {
    const seq = ++historyRequest;
    try {
      const list = await valueOf(liveApi.historyList());
      if (seq !== historyRequest) return;
      $('history-list').replaceChildren(...list.map(item => {
        const row = document.createElement('div'), button = document.createElement('button'), date = document.createElement('small');
        row.className = 'history-row';
        button.type = 'button'; button.className = 'history-item'; button.textContent = item.title;
        button.setAttribute('aria-current', String(item.id === activeThread));
        date.textContent = new Date(item.updatedAt).toLocaleString(); button.append(date);
        button.addEventListener('click', () => { void selectHistory(item.id).catch(error => setError(error.message)); });
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'history-delete'; remove.textContent = '×';
        remove.setAttribute('aria-label', `${item.title} 삭제`); remove.title = '대화 삭제';
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            const result = await valueOf(liveApi.historyDelete(item.id));
            if (result.canceled) return;
            if (activeThread === item.id) { await end(); await selectHistory(null); }
            else await refreshHistory();
          } catch (error) { setError(error.message); }
          finally { remove.disabled = false; }
        });
        row.append(button, remove); return row;
      }));
    } catch (error) { setError(error.message); }
  }
  $('history-open').addEventListener('click', () => sidebar(host.dataset.sidebar !== 'open'));
  $('sidebar-backdrop').addEventListener('click', () => sidebar(false));
  $('history-new').addEventListener('click', () => { void selectHistory(null).catch(error => setError(error.message)); });
  const openSettings = () => { $('model').value = selection.model || ''; $('voice').value = selection.voice || ''; $('permission').value = selection.permission; $('permission-description').textContent = permissions[selection.permission]; $('settings').showModal(); };
  $('permission').addEventListener('change', () => { $('permission-description').textContent = permissions[$('permission').value]; });
  $('workspace-choose').addEventListener('click', async () => {
    try {
      const result = await valueOf(liveApi.chooseWorkspace());
      if (result.canceled) return;
      const changed = workspace !== result.workspace;
      showWorkspace(result.workspace);
      if (changed && current) { await end(); await start(); }
    } catch (error) { setError(error.message); }
  });
  async function answerApproval(approve) {
    const item = approvalQueue[0], session = current;
    if (!item || !session) return;
    try { await valueOf(liveApi.approval(session.key, item.id, approve)); approvalQueue.shift(); } catch (error) { setError(error.message); }
    showApproval();
  }
  $('approval-accept').addEventListener('click', () => answerApproval(true));
  $('approval-deny').addEventListener('click', () => answerApproval(false));
  $('approval').addEventListener('cancel', event => { event.preventDefault(); void answerApproval(false); });
  $('settings-open').addEventListener('click', openSettings);
  $('project-open').addEventListener('click', openSettings);
  $('settings-summary').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => $('settings').close());
  $('reload-catalog').addEventListener('click', () => loadCatalog(true));
  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const next = { model: $('model').value, voice: $('voice').value, permission: $('permission').value };
    if (!catalog?.models.some(m => m.id === next.model) || !catalog.voices.some(v => v.id === next.voice) || !Object.hasOwn(permissions, next.permission)) return;
    const restart = !!current && (next.model !== selection.model || next.voice !== selection.voice || next.permission !== selection.permission);
    selection = next;
    try { localStorage.setItem('codepet.live.selection', JSON.stringify(next)); } catch {}
    $('settings').close(); settingsBusy = true; update();
    try { if (restart) { await end(); await start(); } } finally { settingsBusy = false; update(); }
  });
  window.addEventListener('beforeunload', () => { if (current) { cleanup(current); void liveApi.stop(current.key); current = null; } });
  void loadCatalog();
})();
