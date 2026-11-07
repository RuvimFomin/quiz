// Изолированный сервер для браузерных тестов: редактор не меняет рабочий questions.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-quiz-browser-'));
const root = path.join(__dirname, '..');
for (const file of ['server.js', 'questions.json']) fs.copyFileSync(path.join(root, file), path.join(tmp, file));
fs.cpSync(path.join(root, 'public'), path.join(tmp, 'public'), { recursive: true });
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
require(path.join(tmp, 'server.js'));
