// Звуки экрана ведущего. Синтезируются в браузере (Web Audio), файлы не нужны.
const Sound = (() => {
  let ctx = null;
  let master = null;
  let enabled = false;
  try { enabled = localStorage.getItem('quiz-sound') === 'on'; } catch (_) {}

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Одна мягкая нота: синус + немного обертона, плавная атака и затухание
  function note(freq, start, dur = 0.5, vol = 0.3, type = 'sine') {
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function play(fn) {
    if (!enabled || !ensure()) return;
    fn();
  }

  return {
    get enabled() { return enabled; },
    wake() { if (enabled) ensure(); },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem('quiz-sound', enabled ? 'on' : 'off'); } catch (_) {}
      if (enabled) { ensure(); this.join(); }
      return enabled;
    },
    // Кто-то вошёл в игру
    join: () => play(() => { note(880, 0, 0.18, 0.18); note(1320, 0.07, 0.25, 0.14); }),
    // Кто-то ответил на вопрос
    answer: () => play(() => note(1200, 0, 0.09, 0.07, 'triangle')),
    // Новый вопрос
    question: () => play(() => { note(523.25, 0, 0.35, 0.2); note(659.25, 0.1, 0.35, 0.2); note(783.99, 0.2, 0.6, 0.22); }),
    // Последние 5 секунд
    tick: (last) => play(() => note(last ? 1046.5 : 784, 0, 0.12, last ? 0.22 : 0.14, 'triangle')),
    // Показ правильного ответа
    reveal: () => play(() => { note(659.25, 0, 0.9, 0.2); note(987.77, 0.12, 1.1, 0.18); note(1318.5, 0.24, 1.3, 0.1); }),
    // Таблица лидеров
    board: () => play(() => { note(392, 0, 0.3, 0.15); note(523.25, 0.12, 0.5, 0.15); }),
    // Финал — короткие фанфары
    final: () => play(() => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.13, 0.4, 0.2, 'triangle'));
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => note(f, 0.62, 1.6, 0.12));
    }),
  };
})();

// Браузеры включают звук только после действия пользователя — будим его при первом клике или клавише
['pointerdown', 'keydown'].forEach((ev) =>
  document.addEventListener(ev, () => Sound.wake(), { capture: true })
);
