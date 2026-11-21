import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  escapeHtml,
  formatBytes,
  fromKyivInputValue,
  safeUrl,
  shortSha,
  toKyivInputValue,
  translateCiStatus,
  translateEvent,
  translatePrState,
} from '../public/i18n.js';
import { BUNDLED_SCREENS, createSeedRecords } from '../public/data.js';
import { icon } from '../public/icons.js';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');

test('усі JS-модулі проходять синтаксичну перевірку node --check', () => {
  for (const file of ['app.js', 'data.js', 'i18n.js', 'icons.js', 'screenshots.js']) {
    execFileSync(process.execPath, ['--check', path.join(publicDir, file)]);
  }
});

test('переклад статусів GitHub Actions повертає українські підписи без сирих англійських enum', () => {
  assert.deepEqual(translateCiStatus('completed', 'success'), { label: 'Успішно', tone: 'good' });
  assert.deepEqual(translateCiStatus('completed', 'failure'), { label: 'Помилка', tone: 'danger' });
  assert.deepEqual(translateCiStatus('in_progress', null), { label: 'Триває', tone: 'live' });
  assert.deepEqual(translateCiStatus('queued', null), { label: 'У черзі', tone: 'warn' });
  assert.deepEqual(translateCiStatus('completed', 'cancelled'), { label: 'Скасовано', tone: 'neutral' });
  assert.equal(translateEvent('pull_request'), 'Запит на злиття');
  assert.equal(translateEvent('push'), 'Коміт');
});

test('переклад стану PR коректно розрізняє чернетки, відкриті та злиті PR', () => {
  assert.equal(translatePrState({ state: 'open', draft: true, merged: false }).label, 'Чернетка');
  assert.equal(translatePrState({ state: 'open', draft: false, merged: false }).label, 'Відкритий PR');
  assert.equal(translatePrState({ state: 'closed', draft: false, merged: true }).label, 'Злито');
  assert.equal(translatePrState({ state: 'closed', draft: false, merged: false }).label, 'Закрито');
});

test('конвертація часу Europe/Kyiv для datetime-local оборотна без зміщення UTC', () => {
  const originalIso = '2026-11-21T10:30:00.000Z';
  const kyivInput = toKyivInputValue(originalIso);
  assert.equal(kyivInput, '2026-11-21T12:30');
  const roundtrip = fromKyivInputValue(kyivInput);
  assert.equal(roundtrip, originalIso);
});

test('безпека URL та екранування HTML блокують XSS-схеми', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,<h1>x</h1>'), '');
  assert.equal(safeUrl('https://github.com/hellwikcoop-arch/EasyWAR'), 'https://github.com/hellwikcoop-arch/EasyWAR');
  assert.equal(escapeHtml('<script>"test"</script>'), '&lt;script&gt;&quot;test&quot;&lt;/script&gt;');
  assert.equal(shortSha('91cdeb5aa1cbd36e64478bcd6b0cdc2046939164'), '91cdeb5');
  assert.equal(formatBytes(2048), '2,0 КБ');
});

test('стартові записи та базові скріншоти валідні, а всі файли зображень існують', () => {
  const seed = createSeedRecords();
  assert.ok(seed.some((r) => r.kind === 'cycle'));
  assert.ok(seed.some((r) => r.kind === 'checklist' && r.items.length >= 3));
  for (const scr of BUNDLED_SCREENS) {
    const filePath = path.join(publicDir, scr.src.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(filePath), `Не знайдено скріншот: ${scr.src}`);
  }
  assert.ok(icon('pulse', 18).includes('<svg'));
});
