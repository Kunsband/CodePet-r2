// Keep brief hide/show interactions fast, then release the hidden renderer.
function releaseHiddenWindow(win, { delayMs = 30000, canRelease = () => true } = {}) {
  let timer;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const schedule = () => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (!win.isDestroyed() && !win.isVisible() && canRelease()) win.destroy();
    }, delayMs);
    timer.unref?.();
  };
  win.on("hide", schedule);
  win.on("show", cancel);
  win.once("closed", cancel);
  schedule();
}

module.exports = { releaseHiddenWindow };
