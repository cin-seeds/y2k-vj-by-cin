// Runs off the main thread so a blurred desk (output window focused) still
// wakes the renderer at 60Hz. requestAnimationFrame is paused in that state.
let timer = 0;

self.onmessage = (event) => {
  if (event.data === 'start') {
    if (timer) return;
    timer = setInterval(() => self.postMessage(0), 1000 / 60);
  } else if (event.data === 'stop') {
    clearInterval(timer);
    timer = 0;
  }
};
