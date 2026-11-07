// Небольшой эффект победы без внешних файлов и библиотек.
function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 48; i++) {
    const bit = document.createElement('i');
    bit.style.cssText = `left:${Math.random() * 100}%;background:var(--o${i % 4});animation-delay:${Math.random() * 1.5}s;--spin:${Math.random() * 720}deg`;
    layer.appendChild(bit);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 5500);
}

const boardPositions = new Map();
let previousLeader = null;
function animateLeaderboard(root, list) {
  root.dataset.scoreAnimating = 'false';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const marker = String(performance.now());
  root.dataset.scoreAnimating = marker;
  setTimeout(() => { if (root.dataset.scoreAnimating === marker) root.dataset.scoreAnimating = 'false'; }, 700);
  root.querySelectorAll('.row[data-player]').forEach(row => {
    const player = list.find(p => p.id === row.dataset.player);
    if (!player) return;
    const old = boardPositions.get(player.id);
    const score = row.querySelector('.score');
    const from = old?.score ?? Math.max(0, player.score - player.lastPoints);
    const distance = ((old?.rank ?? player.prevRank ?? player.rank) - player.rank) * 70;
    if (distance) row.animate([{ transform: `translateY(${distance}px)`, opacity: .5 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
    if (player.rank === 1 && previousLeader && previousLeader !== player.id) row.classList.add('new-leader');
    const started = performance.now();
    const frame = now => {
      const progress = Math.min(1, (now - started) / 650);
      score.textContent = Math.round(from + (player.score - from) * (1 - (1 - progress) ** 3)).toLocaleString('ru-RU');
      if (progress < 1 && score.isConnected) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    boardPositions.set(player.id, { rank: player.rank, score: player.score });
  });
  previousLeader = list[0]?.id;
}
