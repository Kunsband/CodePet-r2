const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("settings shows the icon only for an available update, labels it, and handles download clicks", async () => {
  const source = fs.readFileSync(require.resolve("../src/settings.js"), "utf8");
  const buttonEvents = {}, windowEvents = {}, errors = [];
  const button = { hidden: true, disabled: false, addEventListener: (name, handler) => { buttonEvents[name] = handler; },
    setAttribute(name, value) { this[name] = value; } };
  const version = {};
  let result = { status: "up-to-date", currentVersion: "1.0.12" }, downloadCalls = 0;
  const context = { $: selector => selector === "#download-update" ? button : version,
    window: { addEventListener: (name, handler) => { windowEvents[name] = handler; } },
    api: { checkUpdate: async () => result, downloadUpdate: async () => { downloadCalls++; assert.equal(button.disabled, true); return { ok: true }; } },
    showError: text => errors.push(text), responseError: (response, fallback) => response?.error || fallback };
  vm.runInNewContext(source.slice(source.indexOf("function registerUpdateControls()"), source.lastIndexOf("initialize();")), context);
  context.registerUpdateControls(); await new Promise(setImmediate);
  assert.equal(button.hidden, true);
  assert.equal(version.textContent, "VERSION 1.0.12");
  result = { status: "available", currentVersion: "1.0.12", latestVersion: "1.0.13" };
  await windowEvents.focus();
  assert.equal(button.hidden, false); assert.match(button.title, /1\.0\.13.*다운로드/);
  assert.equal(button["aria-label"], button.title);
  await buttonEvents.click();
  assert.equal(downloadCalls, 1); assert.equal(button.disabled, false);
  result = { status: "unavailable", currentVersion: "1.0.12" };
  await windowEvents.focus(); assert.equal(button.hidden, true);
  assert.deepEqual(errors, []);
  context.api.checkUpdate = async () => { throw new Error("offline"); };
  await windowEvents.focus(); assert.equal(button.hidden, true); assert.deepEqual(errors, []);
  context.api.downloadUpdate = async () => ({ ok: false, error: "브라우저 오류" });
  await buttonEvents.click(); assert.deepEqual(errors, ["브라우저 오류"]); assert.equal(button.disabled, false);
});

test("automatic update UI shows progress, prevents duplicate clicks and stays busy through restart", async () => {
  const source = fs.readFileSync(require.resolve("../src/settings.js"), "utf8");
  const buttonEvents = {}, windowEvents = {}, errors = [];
  const button = { hidden: true, disabled: false, addEventListener: (name, handler) => { buttonEvents[name] = handler; },
    setAttribute(name, value) { this[name] = value; } };
  const version = {};
  let progress, finish, calls = 0;
  const context = { $: selector => selector === "#download-update" ? button : version,
    window: { addEventListener: (name, handler) => { windowEvents[name] = handler; } },
    api: { checkUpdate: async () => ({ status: "available", currentVersion: "1.0.12", latestVersion: "1.0.13", automatic: true }),
      onUpdateProgress: handler => { progress = handler; },
      downloadUpdate: () => { calls++; return new Promise(resolve => { finish = resolve; }); } },
    showError: text => errors.push(text), responseError: (response, fallback) => response?.error || fallback };
  vm.runInNewContext(source.slice(source.indexOf("function registerUpdateControls()"), source.lastIndexOf("initialize();")), context);
  context.registerUpdateControls(); await new Promise(setImmediate);
  assert.match(button.title, /업데이트 후 재시작/);
  const click = buttonEvents.click();
  await buttonEvents.click(); assert.equal(calls, 1);
  progress({ phase: "downloading", percent: 42 });
  await windowEvents.focus();
  assert.equal(version.textContent, "다운로드 42%"); assert.equal(button.disabled, true);
  progress({ phase: "verifying" }); assert.equal(version.textContent, "파일 확인 중…");
  finish({ ok: true, restarting: true }); await click;
  assert.equal(version.textContent, "재시작 중…"); assert.equal(button.disabled, true);
  progress({ phase: "error" }); assert.equal(button.disabled, false);
  assert.equal(version.textContent, "VERSION 1.0.12");
  const retry = buttonEvents.click(); finish({ ok: false, error: "검증 실패" }); await retry;
  assert.equal(button.disabled, false); assert.deepEqual(errors, ["검증 실패"]);
});
