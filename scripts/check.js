const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const fixture = require('../tests/content.fixture.json');
const data = require('../questions.json');
const content = d => ({ title: d.title, questions: d.questions.map(({ id, category, question, answers, correct, time }) => ({ id, category, question, answers, correct, time })) });
assert.deepEqual(content(data), content(fixture), 'Формулировки, ключи и порядок должны соответствовать исходному ТЗ');
assert.equal(data.questions.length, 25);
assert.equal(new Set(data.questions.map(q => q.id)).size, 25);
assert.equal(data.questions.filter(q => q.category === 'Посвящение Богу своей воли').length, 15);
assert.equal(data.questions.filter(q => q.category === 'Разум и чувства').length, 10);
data.questions.forEach(q => {
  assert.equal(q.answers.length, 4);
  assert(q.correct >= 0 && q.correct <= 3 && Number.isInteger(q.correct));
  assert.equal(q.time, 30);
});
for (const name of fs.readdirSync('public')) {
  if (!/\.(js|html|css)$/.test(name)) continue;
  const text = fs.readFileSync('public/' + name, 'utf8');
  assert(!/photoFor|PHOTOS|p\.photo|me\.photo|photos\[|\/people\//.test(text), 'Фото в ' + name);
  if (name.endsWith('.js')) new vm.Script(text, { filename: name });
  if (name.endsWith('.html')) for (const [, script] of text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script, { filename: name });
}
new vm.Script(fs.readFileSync('server.js', 'utf8'), { filename: 'server.js' });
assert(!fs.existsSync('public/people'));
console.log('OK: 25 вопросов, 100 вариантов, ключи и порядок, категории 15/10, синтаксис, отсутствие фото');
