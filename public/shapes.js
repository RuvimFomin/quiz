// Цветные фигуры вместо букв A/B/C/D
const SHAPES = [
  '<circle cx="12" cy="12" r="9"/>',
  '<path d="M12 3.2c.5 0 .9.3 1.2.7l8 14.2c.5.9-.1 2-1.2 2H4c-1 0-1.7-1.1-1.2-2l8-14.2c.3-.4.7-.7 1.2-.7z"/>',
  '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/>',
  '<path d="M10.6 2.9a2 2 0 0 1 2.8 0l7.7 7.7a2 2 0 0 1 0 2.8l-7.7 7.7a2 2 0 0 1-2.8 0l-7.7-7.7a2 2 0 0 1 0-2.8z"/>',
  '<path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z"/>',
  '<path d="M12 2.8l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17l-5.6 3 1.1-6.2L3 9.4l6.2-.9z"/>',
];
function shape(i) {
  return `<span class="shape c${i}"><svg viewBox="0 0 24 24">${SHAPES[i % SHAPES.length]}</svg></span>`;
}

// Аватар участника: фото, если есть, иначе эмодзи
function avatar(p, cls = '') {
  return p.photo
    ? `<img class="ava ${cls}" src="${p.photo}" alt="">`
    : `<span class="${cls}">${p.emoji}</span>`;
}
