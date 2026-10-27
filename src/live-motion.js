"use strict";

// Each row has six actual drawings. Long holds and short eyelid/viseme
// transitions give each motion its own rhythm instead of flipping two poses.
(() => {
  const host = document.querySelector('.live-window');
  const sprite = host.querySelector(".character-frame");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const sequences = {
    breathing: [[0,650],[1,500],[2,600],[3,650],[4,500],[5,650]],
    blink: [[6,50],[7,55],[8,45],[9,75],[10,65],[11,55]],
    speaking: [[12,170],[13,100],[14,120],[15,85],[16,100],[13,90],[12,180],
      [13,90],[16,120],[15,90],[14,110],[13,100],[17,260]],
    thinking: [[18,1000],[22,220],[20,360],[22,240],[23,850],[21,300],[23,1300]],
  };
  // The atlas drawings are spaced slightly more tightly than their cells.
  // Register the base pose horizontally, keeping the original asset intact.
  const columnOffsets = [-4.688,-2.734,-1.172,1.172,2.734,4.688];
  const blinkIntervals = [3900,5700,4400,6200,3400];
  let state = host.dataset.state;
  let elapsed = 0;
  let lastTimestamp = null;
  let blinkStart = null;
  let blinkIndex = 0;
  let nextBlink = blinkIntervals[0];
  let currentFrame = -1;
  let raf = null;

  function frameAt(sequence, time, loop = true) {
    const duration = sequence.reduce((sum, pair) => sum + pair[1], 0);
    let offset = loop ? time % duration : Math.min(time, duration - 1);
    for (const [frame, hold] of sequence) {
      if (offset < hold) return frame;
      offset -= hold;
    }
    return sequence.at(-1)[0];
  }

  function showFrame(frame) {
    if (frame === currentFrame) return;
    currentFrame = frame;
    sprite.dataset.frame = String(frame);
    sprite.style.setProperty("--frame-x", `${(frame % 6) * 20}%`);
    sprite.style.setProperty("--frame-y", `${Math.floor(frame / 6) * 100 / 3}%`);
    sprite.style.transform = `translate(${columnOffsets[frame % 6]}%, ${frame >= 18 ? 3.125 : 0}%)`;
  }

  function tick(timestamp) {
    raf = null;
    if (document.hidden) { lastTimestamp = null; return; }
    if (host.dataset.state !== state) {
      state = host.dataset.state;
      elapsed = 0;
      blinkStart = null;
      nextBlink = blinkIntervals[blinkIndex % blinkIntervals.length];
    }
    if (lastTimestamp !== null) elapsed += Math.min(timestamp - lastTimestamp, 100);
    lastTimestamp = timestamp;
    if (reducedMotion.matches || state === "ended") {
      showFrame(state === "speaking" ? 14 : state === "thinking" ? 20 : 0);
    } else {
      if (elapsed >= nextBlink && blinkStart === null) blinkStart = elapsed;
      if (blinkStart !== null && elapsed - blinkStart >= 345) {
        blinkStart = null;
        blinkIndex += 1;
        nextBlink = elapsed + blinkIntervals[blinkIndex % blinkIntervals.length];
      }
      if (blinkStart !== null) showFrame(frameAt(sequences.blink, elapsed - blinkStart, false));
      else showFrame(frameAt(sequences[state === "speaking" ? "speaking" : state === "thinking" ? "thinking" : "breathing"], elapsed));
    }
    raf = requestAnimationFrame(tick);
  }

  document.addEventListener("visibilitychange", () => {
    lastTimestamp = null;
    if (document.hidden) { cancelAnimationFrame(raf); raf = null; }
    else if (raf === null) raf = requestAnimationFrame(tick);
  });
  raf = requestAnimationFrame(tick);
})();
