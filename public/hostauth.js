// Пароль ведущего: из ссылки ?key=… или из памяти браузера. На локальном компьютере не нужен.
const KEY = (() => {
  const fromUrl = new URLSearchParams(location.search).get('key');
  try {
    if (fromUrl) localStorage.setItem('quiz-host-key', fromUrl);
    if (fromUrl) history.replaceState(null, '', location.pathname); // не показываем пароль в адресной строке
    return fromUrl || localStorage.getItem('quiz-host-key') || '';
  } catch (_) {
    return fromUrl || '';
  }
})();

async function requireHost(start) {
  const r = await fetch('/api/host/check', { headers: { 'X-Host-Key': KEY } }).catch(() => null);
  if (r && r.ok) return start();
  const box = document.createElement('div');
  box.className = 'authbox';
  box.innerHTML = `
    <form class="card">
      <p class="eyebrow">Экран ведущего</p>
      <h2>Введите пароль</h2>
      <input class="input" type="password" placeholder="Пароль ведущего" autocomplete="current-password">
      <p class="err"></p>
      <button class="btn wide" type="submit">Войти</button>
    </form>`;
  document.body.appendChild(box);
  const input = box.querySelector('input');
  input.focus();
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    const ok = await fetch('/api/host/check', { headers: { 'X-Host-Key': key } }).then((x) => x.ok).catch(() => false);
    if (!ok) return (box.querySelector('.err').textContent = 'Неверный пароль');
    try { localStorage.setItem('quiz-host-key', key); } catch (_) {}
    location.reload();
  });
}
