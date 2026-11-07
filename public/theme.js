(() => {
  try { document.documentElement.dataset.theme = localStorage.getItem('quiz-theme') || 'light'; } catch (_) {}
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('quiz-theme', theme); } catch (_) {}
  });
})();
