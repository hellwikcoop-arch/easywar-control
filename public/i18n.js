const KYIV_TZ = 'Europe/Kyiv';

const fmtDateTime = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV_TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const fmtDateShort = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV_TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const fmtTimeOnly = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV_TZ,
  hour: '2-digit',
  minute: '2-digit',
});

const fmtNumber = new Intl.NumberFormat('uk-UA');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function safeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return fmtNumber.format(Number(value));
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : fmtDateTime.format(date);
}

export function formatDateShort(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : fmtDateShort.format(date);
}

export function formatTimeOnly(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : fmtTimeOnly.format(date);
}

export function formatRelative(iso, nowMs = Date.now()) {
  if (!iso) return 'невідомо';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'невідомо';
  const diffSec = Math.round((nowMs - date.getTime()) / 1000);
  if (diffSec < 45) return 'щойно';
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins} хв тому`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} дн тому`;
  return fmtDateShort.format(date);
}

/**
 * Конвертує ISO-час у значення для <input type="datetime-local"> за київським часом.
 */
export function toKyivInputValue(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: KYIV_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/**
 * Перетворює локальне київське значення datetime-local назад у точний ISO UTC.
 */
export function fromKyivInputValue(localStr) {
  if (!localStr || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localStr)) return new Date().toISOString();
  const [datePart, timePart] = localStr.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  // Початкове наближення як UTC, далі коригуємо зміщення часового поясу Europe/Kyiv
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const formatted = toKyivInputValue(new Date(utcGuess).toISOString());
  if (formatted === localStr) return new Date(utcGuess).toISOString();
  const [fDate, fTime] = formatted.split('T');
  const [fy, fm, fd] = fDate.split('-').map(Number);
  const [fh, fmin] = fTime.split(':').map(Number);
  const kyivAsUtc = Date.UTC(fy, fm - 1, fd, fh, fmin);
  const offsetMs = kyivAsUtc - utcGuess;
  return new Date(utcGuess - offsetMs).toISOString();
}

export function translateCiStatus(status, conclusion) {
  const key = (conclusion || status || '').toLowerCase();
  const map = {
    success: { label: 'Успішно', tone: 'good' },
    failure: { label: 'Помилка', tone: 'danger' },
    timed_out: { label: 'Таймаут', tone: 'danger' },
    startup_failure: { label: 'Помилка запуску', tone: 'danger' },
    cancelled: { label: 'Скасовано', tone: 'neutral' },
    skipped: { label: 'Пропущено', tone: 'neutral' },
    neutral: { label: 'Нейтрально', tone: 'neutral' },
    stale: { label: 'Застаріло', tone: 'neutral' },
    action_required: { label: 'Потрібна дія', tone: 'warn' },
    in_progress: { label: 'Триває', tone: 'live' },
    queued: { label: 'У черзі', tone: 'warn' },
    waiting: { label: 'Очікує', tone: 'warn' },
    pending: { label: 'Очікує', tone: 'warn' },
    requested: { label: 'Запитано', tone: 'warn' },
    completed: { label: 'Завершено', tone: 'good' },
  };
  return map[key] || { label: 'Невідомо', tone: 'neutral' };
}

export function translatePrState(pr) {
  if (pr.merged) return { label: 'Злито', tone: 'good' };
  if (pr.state === 'closed') return { label: 'Закрито', tone: 'neutral' };
  if (pr.draft) return { label: 'Чернетка', tone: 'warn' };
  return { label: 'Відкритий PR', tone: 'live' };
}

export function translateEvent(eventName) {
  const map = {
    push: 'Коміт',
    pull_request: 'Запит на злиття',
    workflow_dispatch: 'Ручний запуск',
    release: 'Реліз',
    schedule: 'За розкладом',
    merge_group: 'Черга злиття',
  };
  return map[eventName] || 'Подія GitHub';
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '—';
}
