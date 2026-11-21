import {
  AGENT_ROLES,
  AGENT_STATUSES,
  BUNDLED_SCREENS,
  DEFAULT_REPOS,
  ROLE_OPTIONS,
  STATUS_BY_KIND,
  WORK_KINDS,
  createSeedRecords,
} from './data.js';
import {
  escapeHtml,
  formatBytes,
  formatDateShort,
  formatDateTime,
  formatNumber,
  formatRelative,
  fromKyivInputValue,
  safeUrl,
  shortSha,
  toKyivInputValue,
  translateCiStatus,
  translateEvent,
  translatePrState,
} from './i18n.js';
import { icon } from './icons.js';
import {
  deleteLocalScreenshot,
  loadLocalScreenshots,
  saveLocalScreenshots,
} from './screenshots.js';

const STORAGE_RECORDS_KEY = 'easywar-control-v4-records';
const STORAGE_PENDING_KEY = 'easywar-control-v4-pending';
const STORAGE_REPO_KEY = 'easywar-control-v4-repo';

const ROUTES = [
  { id: 'pulse', label: 'Пульс', icon: 'pulse', subtitle: 'Оперативний стан репозиторію, збірок та приймання' },
  { id: 'code', label: 'Код і релізи', icon: 'code', subtitle: 'Запити на злиття, перевірки CI, коміти, гілки та релізи' },
  { id: 'screens', label: 'Екрани й збірки', icon: 'screens', subtitle: 'Знімки інтерфейсу EasyWAR з CI та локальні перевірки' },
  { id: 'work', label: 'Приймання й задачі', icon: 'work', subtitle: 'Чеклісти приймання, завдання, рішення та відкриті питання' },
  { id: 'agents', label: 'Агенти й журнал', icon: 'agents', subtitle: 'Чернетки доручень агентам, ліміти та журнал оновлень' },
];

const appEl = document.getElementById('app');
const drawerDialog = document.getElementById('drawer-dialog');
const modalDialog = document.getElementById('modal-dialog');
const lightboxDialog = document.getElementById('lightbox-dialog');
const toastEl = document.getElementById('toast');

let toastTimer = null;
let blobUrls = [];

const state = {
  route: 'pulse',
  repoScope: loadSavedRepoScope(),
  codeTab: 'pr',
  codePrFilter: 'open',
  codeQuery: '',
  workTab: 'all',
  workQuery: '',
  workStatus: '',
  workRole: '',
  agentsTab: 'tasks',
  logQuery: '',
  mobileMenuOpen: false,

  csrfToken: '',
  serverReady: false,
  serverRevision: 0,
  serverOnline: false,
  conflictMessage: '',
  storageNotice: '',
  saving: false,
  refreshing: false,

  records: loadInitialRecords(),
  live: {
    refreshedAt: null,
    owner: 'hellwikcoop-arch',
    configuredRepos: [...DEFAULT_REPOS],
    repos: [],
    branches: [],
    pulls: [],
    commits: [],
    runs: [],
    releases: [],
    screens: [],
    warnings: [],
    rateLimit: { remaining: null, limit: null, resetAt: null, authenticated: false },
    stale: true,
    error: '',
  },
  agentTasks: [],
  editingAgentTaskId: null,
  agentDraftPrefill: null,
  localScreens: [],
  lightboxList: [],
  lightboxIndex: 0,
};

function loadSavedRepoScope() {
  try {
    return localStorage.getItem(STORAGE_REPO_KEY) || 'EasyWAR';
  } catch {
    return 'EasyWAR';
  }
}

function loadInitialRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_RECORDS_KEY);
    if (!raw) return createSeedRecords();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // Пошкоджені локальні дані скидаємо до стартового набору
  }
  return createSeedRecords();
}

function saveRecordsLocally() {
  try {
    localStorage.setItem(STORAGE_RECORDS_KEY, JSON.stringify(state.records));
    return true;
  } catch {
    state.storageNotice = 'Не вдалося записати локальну копію в браузері (перевірте вільне місце).';
    return false;
  }
}

function setPendingSync(pending) {
  try {
    if (pending) {
      localStorage.setItem(STORAGE_PENDING_KEY, String(Date.now()));
    } else {
      localStorage.removeItem(STORAGE_PENDING_KEY);
    }
  } catch {
    // Ігноруємо обмеження сховища
  }
}

function hasPendingSync() {
  try {
    return Boolean(localStorage.getItem(STORAGE_PENDING_KEY));
  } catch {
    return false;
  }
}

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3600);
}

function copyText(text, label = 'Скопійовано') {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast(label),
      () => fallbackCopy(text, label),
    );
  } else {
    fallbackCopy(text, label);
  }
}

function fallbackCopy(text, label) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast(label);
  } catch {
    showToast('Не вдалося скопіювати автоматично.');
  } finally {
    ta.remove();
  }
}

function matchesRepo(repo) {
  if (state.repoScope === 'ALL') return true;
  return repo === state.repoScope;
}

function configuredRepos() {
  return state.live.configuredRepos?.length ? state.live.configuredRepos : DEFAULT_REPOS;
}

function scopedPulls() {
  return (state.live.pulls || []).filter((item) => matchesRepo(item.repo));
}

function scopedRuns() {
  return (state.live.runs || []).filter((item) => matchesRepo(item.repo));
}

function scopedCommits() {
  return (state.live.commits || []).filter((item) => matchesRepo(item.repo));
}

function scopedBranches() {
  return (state.live.branches || []).filter((item) => matchesRepo(item.repo));
}

function scopedReleases() {
  return (state.live.releases || []).filter((item) => matchesRepo(item.repo));
}

function scopedRecords(kind = null) {
  return state.records.filter((item) => {
    if (kind && item.kind !== kind) return false;
    return !item.repo || matchesRepo(item.repo);
  });
}

function getCycleRecord() {
  const exact = state.records.find((r) => r.kind === 'cycle' && matchesRepo(r.repo || 'EasyWAR'));
  return exact || state.records.find((r) => r.kind === 'cycle') || null;
}

function statusTone(status) {
  const val = String(status || '').toLowerCase();
  if (val.includes('виконано') || val.includes('погоджено') || val.includes('закрито') || val.includes('успішно') || val.includes('межах')) {
    return 'good';
  }
  if (val.includes('помил') || val.includes('заблок') || val.includes('перевищ')) {
    return 'danger';
  }
  if (val.includes('увага') || val.includes('відповідь') || val.includes('погодженні') || val.includes('чернет')) {
    return 'warn';
  }
  if (val.includes('роботі') || val.includes('актив') || val.includes('перевір')) {
    return 'live';
  }
  return 'neutral';
}

function addAutoLog(title, description, repo = 'EasyWAR') {
  state.records.unshift({
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    kind: 'log',
    title,
    description,
    repo: repo === 'ALL' ? 'EasyWAR' : repo,
    role: 'Власник',
    status: 'Зафіксовано',
    date: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Зберігаємо помірну історію автоматичних записів
  const logs = state.records.filter((r) => r.kind === 'log');
  if (logs.length > 200) {
    const keepIds = new Set(logs.slice(0, 200).map((l) => l.id));
    state.records = state.records.filter((r) => r.kind !== 'log' || keepIds.has(r.id));
  }
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') {
    headers['X-EasyWAR-CSRF'] = state.csrfToken;
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'Некоректна відповідь сервера.' };
  }
  return { ok: response.ok, status: response.status, data };
}

async function persistRecords({ logTitle = '', logDesc = '', logRepo = '' } = {}) {
  if (logTitle) {
    addAutoLog(logTitle, logDesc, logRepo || (state.repoScope === 'ALL' ? 'EasyWAR' : state.repoScope));
  }
  saveRecordsLocally();
  setPendingSync(true);
  await syncRecordsToServer();
}

async function syncRecordsToServer() {
  if (!state.csrfToken || state.saving) return;
  if (!hasPendingSync() && !state.conflictMessage) return;
  state.saving = true;
  try {
    const res = await apiFetch('/api/records', {
      method: 'PUT',
      body: JSON.stringify({
        revision: state.serverRevision,
        records: state.records,
      }),
    });
    if (res.ok && res.data && typeof res.data.revision === 'number') {
      state.serverRevision = res.data.revision;
      state.serverReady = true;
      state.serverOnline = true;
      state.conflictMessage = '';
      setPendingSync(false);
    } else if (res.status === 409) {
      state.serverReady = false;
      state.conflictMessage = res.data?.error || 'Конфлікт версій записів між пристроями.';
    } else {
      state.storageNotice = res.data?.error || 'Не вдалося синхронізувати записи із сервером.';
    }
  } catch {
    state.serverOnline = false;
  } finally {
    state.saving = false;
    render();
  }
}

async function initServer() {
  try {
    const sess = await apiFetch('/api/session');
    if (!sess.ok || !sess.data?.csrfToken) {
      state.serverOnline = false;
      render();
      return;
    }
    state.csrfToken = sess.data.csrfToken;
    state.serverOnline = true;
    if (Array.isArray(sess.data.repos) && sess.data.repos.length) {
      state.live.configuredRepos = sess.data.repos;
    }

    const [recRes, taskRes] = await Promise.all([
      apiFetch('/api/records'),
      apiFetch('/api/agent-tasks'),
    ]);

    if (recRes.ok && recRes.data) {
      const serverRev = recRes.data.revision || 0;
      const serverRecs = recRes.data.records;
      if (Array.isArray(serverRecs)) {
        if (hasPendingSync()) {
          state.serverRevision = serverRev;
          state.conflictMessage = 'Знайдено незбережені локальні зміни. Оберіть, яку версію залишити.';
          state.serverReady = false;
        } else {
          state.records = serverRecs;
          state.serverRevision = serverRev;
          state.serverReady = true;
          saveRecordsLocally();
        }
      } else {
        // Перший запуск порожньої серверної БД: ініціалізуємо її поточними записами
        state.serverRevision = serverRev;
        setPendingSync(true);
        await syncRecordsToServer();
      }
    }

    if (taskRes.ok && Array.isArray(taskRes.data?.tasks)) {
      state.agentTasks = taskRes.data.tasks;
    }
  } catch {
    state.serverOnline = false;
  }
  render();
  await fetchLive({ force: false });
}

async function fetchLive({ force = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  render();
  try {
    const res = force
      ? await apiFetch('/api/live/refresh', { method: 'POST' })
      : await apiFetch('/api/live');
    if (res.ok && res.data) {
      state.live = { ...state.live, ...res.data };
      state.serverOnline = true;
      if (force) {
        if (res.data.cooldownNotice) {
          showToast(res.data.cooldownNotice);
        } else if (res.data.stale && res.data.error) {
          showToast(res.data.error);
        } else {
          showToast('Дані GitHub оновлено.');
        }
      }
    } else if (force) {
      showToast(res.data?.error || 'Не вдалося оновити дані GitHub.');
    }
  } catch {
    state.serverOnline = false;
    state.live.stale = true;
    state.live.error = 'Локальний сервер недоступний. Показано локальний стан.';
    if (force) showToast('Локальний сервер недоступний.');
  } finally {
    state.refreshing = false;
    render();
  }
}

async function refreshLocalScreens() {
  try {
    state.localScreens = await loadLocalScreenshots();
  } catch {
    state.localScreens = [];
  }
  render();
}

function revokeBlobUrls() {
  for (const url of blobUrls) {
    URL.revokeObjectURL(url);
  }
  blobUrls = [];
}

function parseRoute() {
  const hash = (location.hash || '#pulse').replace(/^#/, '').split('/')[0];
  const found = ROUTES.find((r) => r.id === hash);
  state.route = found ? found.id : 'pulse';
}

function navigate(routeId, opts = {}) {
  if (opts.codeTab) state.codeTab = opts.codeTab;
  if (opts.codePrFilter) state.codePrFilter = opts.codePrFilter;
  if (opts.workTab) state.workTab = opts.workTab;
  if (opts.agentsTab) state.agentsTab = opts.agentsTab;
  state.mobileMenuOpen = false;
  const targetHash = `#${routeId}`;
  if (location.hash !== targetHash) {
    location.hash = targetHash;
  } else {
    state.route = routeId;
    render();
  }
}

/* ===== Attention Engine (Що потребує уваги зараз) ===== */
function buildAttentionItems() {
  const items = [];
  const runs = scopedRuns();
  const pulls = scopedPulls();

  // 1. Помилки в останніх CI запусках (беремо найсвіжіший запуск на кожен workflow)
  const latestByWorkflow = new Map();
  for (const run of runs) {
    const key = `${run.repo}:${run.name}`;
    if (!latestByWorkflow.has(key)) latestByWorkflow.set(key, run);
  }
  for (const run of latestByWorkflow.values()) {
    const st = translateCiStatus(run.status, run.conclusion);
    if (st.tone === 'danger') {
      items.push({
        tone: 'danger',
        icon: 'alert',
        title: `Помилка збірки: ${run.name}`,
        meta: `${run.repo} · ${run.branch} · ${formatRelative(run.createdAt)}`,
        action: () => navigate('code', { codeTab: 'runs' }),
      });
    } else if (st.tone === 'live') {
      items.push({
        tone: 'live',
        icon: 'ci',
        title: `Триває збірка: ${run.name}`,
        meta: `${run.repo} · ${run.branch} · ${formatRelative(run.createdAt)}`,
        action: () => navigate('code', { codeTab: 'runs' }),
      });
    }
  }

  // 2. Відкриті PR (спочатку готові до рев’ю, потім чернетки)
  const openPrs = pulls.filter((p) => p.state === 'open');
  const readyPrs = openPrs.filter((p) => !p.draft);
  const draftPrs = openPrs.filter((p) => p.draft);
  if (readyPrs.length) {
    items.push({
      tone: 'live',
      icon: 'pr',
      title: `PR очікують рев’ю: ${readyPrs.length}`,
      meta: readyPrs.slice(0, 2).map((p) => `#${p.number} ${p.title}`).join(' · '),
      action: () => navigate('code', { codeTab: 'pr', codePrFilter: 'open' }),
    });
  }
  if (draftPrs.length) {
    items.push({
      tone: 'warn',
      icon: 'pr',
      title: `Відкриті чернетки PR: ${draftPrs.length}`,
      meta: draftPrs.slice(0, 2).map((p) => `#${p.number} ${p.title}`).join(' · '),
      action: () => navigate('code', { codeTab: 'pr', codePrFilter: 'draft' }),
    });
  }

  // 3. Відкриті питання
  const openQuestions = scopedRecords('question').filter((q) => q.status !== 'Закрито');
  if (openQuestions.length) {
    items.push({
      tone: 'warn',
      icon: 'question',
      title: `Відкриті питання без відповіді: ${openQuestions.length}`,
      meta: openQuestions[0].title,
      action: () => navigate('work', { workTab: 'question' }),
    });
  }

  // 4. Незавершені чеклісти приймання
  const pendingChecks = scopedRecords('checklist').filter((c) => c.status !== 'Виконано');
  if (pendingChecks.length) {
    const total = pendingChecks.reduce((acc, c) => acc + (c.items?.length || 0), 0);
    const done = pendingChecks.reduce((acc, c) => acc + (c.items || []).filter((i) => i.done).length, 0);
    items.push({
      tone: 'neutral',
      icon: 'work',
      title: `Незавершене приймання: ${done} із ${total} пунктів`,
      meta: pendingChecks[0].title,
      action: () => navigate('work', { workTab: 'checklist' }),
    });
  }

  return items.slice(0, 6);
}

/* ===== Rendering Shell ===== */
function render() {
  revokeBlobUrls();
  const openPrCount = scopedPulls().filter((p) => p.state === 'open').length;
  const openQuestionCount = scopedRecords('question').filter((q) => q.status !== 'Закрито').length;
  const failedCiCount = scopedRuns().slice(0, 10).filter((r) => translateCiStatus(r.status, r.conclusion).tone === 'danger').length;

  const currentRouteMeta = ROUTES.find((r) => r.id === state.route) || ROUTES[0];
  document.title = `${currentRouteMeta.label} · Центр контролю EasyWAR`;

  const repos = configuredRepos();

  appEl.innerHTML = `
    <aside id="sidebar" class="sidebar ${state.mobileMenuOpen ? 'is-open' : ''}" aria-label="Навігація центру контролю">
      <a class="brand" href="#pulse">
        <img src="./badge.svg" alt="" width="38" height="38">
        <span class="brand-text">
          <strong>EasyWAR</strong>
          <small>Центр контролю</small>
        </span>
      </a>

      <div class="nav-section-title">Контроль репозиторію</div>
      <nav class="nav-list">
        ${ROUTES.map((route) => {
          let badge = '';
          if (route.id === 'code' && failedCiCount > 0) {
            badge = `<span class="nav-badge is-danger num" title="Помилки CI">${failedCiCount}</span>`;
          } else if (route.id === 'code' && openPrCount > 0) {
            badge = `<span class="nav-badge num" title="Відкриті PR">${openPrCount}</span>`;
          } else if (route.id === 'work' && openQuestionCount > 0) {
            badge = `<span class="nav-badge is-warn num" title="Відкриті питання">${openQuestionCount}</span>`;
          }
          return `
            <a class="nav-link ${state.route === route.id ? 'is-active' : ''}"
               href="#${route.id}"
               ${state.route === route.id ? 'aria-current="page"' : ''}>
              ${icon(route.icon, 18)}
              <span>${escapeHtml(route.label)}</span>
              ${badge}
            </a>
          `;
        }).join('')}
      </nav>

      <div class="sidebar-foot">
        <div class="storage-pill ${state.serverOnline ? '' : 'is-offline'}">
          ${icon('local', 18)}
          <div>
            <strong>${state.serverOnline ? (state.serverReady ? 'Сховище Mac · SQLite' : 'Очікує синхронізацію') : 'Автономна копія'}</strong>
            <small>${state.serverOnline ? 'GitHub: лише читання' : 'Зміни збережено локально'}</small>
          </div>
        </div>
        <div class="sidebar-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="export-backup" title="Завантажити резервну копію JSON">
            ${icon('download', 14)}
            <span>Бекап</span>
          </button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="trigger-import" title="Відновити записи з JSON">
            ${icon('upload', 14)}
            <span>Імпорт</span>
          </button>
        </div>
        <input id="backup-import-input" type="file" accept="application/json,.json" hidden>
      </div>
    </aside>

    ${state.mobileMenuOpen ? '<button type="button" class="nav-scrim" data-action="close-menu" aria-label="Закрити меню"></button>' : ''}

    <div class="main-col">
      <header class="topbar">
        <button type="button" class="mobile-menu-btn" data-action="toggle-menu" aria-label="Меню" aria-expanded="${state.mobileMenuOpen}">
          ${icon('menu', 19)}
        </button>

        <div class="repo-switcher" role="group" aria-label="Фільтр репозиторію">
          ${repos.map((repo) => `
            <button type="button" class="repo-chip ${state.repoScope === repo ? 'is-active' : ''}" data-repo-scope="${escapeHtml(repo)}">
              ${escapeHtml(repo)}
            </button>
          `).join('')}
          <button type="button" class="repo-chip ${state.repoScope === 'ALL' ? 'is-active' : ''}" data-repo-scope="ALL">
            Усі
          </button>
        </div>

        <div class="topbar-right">
          <button type="button" class="search-btn" data-action="open-search" aria-label="Глобальний пошук">
            ${icon('search', 16)}
            <span>Пошук</span>
            <kbd>/</kbd>
          </button>
          <button type="button" class="btn btn-sm" data-action="refresh-live" ${state.refreshing ? 'disabled' : ''}>
            ${icon('refresh', 15, state.refreshing ? 'is-spinning' : '')}
            <span>${state.refreshing ? 'Оновлення…' : 'Оновити'}</span>
          </button>
        </div>
      </header>

      <main id="content" class="content" tabindex="-1">
        ${renderBanners()}
        ${renderView()}
      </main>
    </div>
  `;
}

function renderBanners() {
  const blocks = [];

  if (state.conflictMessage) {
    blocks.push(`
      <section class="conflict-banner" role="alert">
        <div><strong>Конфлікт збереження:</strong> ${escapeHtml(state.conflictMessage)}</div>
        <div class="conflict-actions">
          <button type="button" class="btn btn-sm" data-action="export-backup">Завантажити локальну копію</button>
          <button type="button" class="btn btn-sm" data-action="resolve-use-server">Взяти записи із сервера</button>
          <button type="button" class="btn btn-sm btn-primary" data-action="resolve-use-local">Замінити серверні локальними</button>
        </div>
      </section>
    `);
  } else if (state.storageNotice) {
    blocks.push(`
      <div class="status-strip is-warn" role="alert">
        <div class="status-strip-main">${icon('alert', 16)}<span>${escapeHtml(state.storageNotice)}</span></div>
      </div>
    `);
  }

  const isStale = state.live.stale || Boolean(state.live.error);
  const rate = state.live.rateLimit || {};
  const rateText = rate.limit
    ? `${rate.authenticated ? 'Токен читання' : 'Публічний режим'} · ліміт ${formatNumber(rate.remaining)}/${formatNumber(rate.limit)}`
    : (rate.authenticated ? 'Токен читання' : 'Публічний режим');

  let liveText = 'GitHub: з’єднання…';
  if (state.live.error) {
    liveText = state.live.error;
  } else if (state.live.refreshedAt) {
    liveText = `GitHub синхронізовано ${formatRelative(state.live.refreshedAt)} (${formatDateTime(state.live.refreshedAt)})`;
  }

  const warnInline = (state.live.warnings || []).length
    ? ` · Попереджень: ${state.live.warnings.length}`
    : '';

  blocks.push(`
    <div class="status-strip ${isStale ? 'is-warn' : ''}" role="status">
      <div class="status-strip-main">
        ${icon(isStale ? 'alert' : 'shield', 16)}
        <span>${escapeHtml(liveText)}${escapeHtml(warnInline)}</span>
      </div>
      <div class="status-strip-meta num">
        <span>${escapeHtml(rateText)}</span>
      </div>
    </div>
  `);

  return blocks.join('');
}

function renderView() {
  switch (state.route) {
    case 'code':
      return renderCodeView();
    case 'screens':
      return renderScreensView();
    case 'work':
      return renderWorkView();
    case 'agents':
      return renderAgentsView();
    case 'pulse':
    default:
      return renderPulseView();
  }
}

/* ===== View 1: Пульс (Огляд) ===== */
function renderPulseView() {
  const pulls = scopedPulls();
  const openPrs = pulls.filter((p) => p.state === 'open');
  const draftCount = openPrs.filter((p) => p.draft).length;
  const readyCount = openPrs.length - draftCount;

  const runs = scopedRuns();
  const recentRuns = runs.slice(0, 6);
  const passedRuns = recentRuns.filter((r) => translateCiStatus(r.status, r.conclusion).tone === 'good').length;
  const failedRuns = recentRuns.filter((r) => translateCiStatus(r.status, r.conclusion).tone === 'danger').length;
  const liveRuns = recentRuns.filter((r) => translateCiStatus(r.status, r.conclusion).tone === 'live').length;

  const checklists = scopedRecords('checklist');
  const totalCheckItems = checklists.reduce((acc, c) => acc + (c.items?.length || 0), 0);
  const doneCheckItems = checklists.reduce((acc, c) => acc + (c.items || []).filter((i) => i.done).length, 0);

  const releases = scopedReleases();
  const latestRelease = releases[0] || null;
  const commits = scopedCommits().slice(0, 5);
  const nextSteps = scopedRecords('next').filter((n) => n.status !== 'Виконано').slice(0, 4);
  const cycle = getCycleRecord();
  const attention = buildAttentionItems();

  const scopeLabel = state.repoScope === 'ALL' ? 'усіх репозиторіїв' : state.repoScope;

  return `
    <section class="page-head">
      <div>
        <h1>Пульс ${escapeHtml(state.repoScope === 'ALL' ? 'EasyWAR' : state.repoScope)}</h1>
        <p>Контроль стану ${escapeHtml(scopeLabel)}: PR, збірки CI, релізи та приймання змін</p>
      </div>
      <div class="page-head-actions">
        <button type="button" class="btn btn-primary" data-action="open-create-menu">
          ${icon('add', 16)}
          <span>Новий запис</span>
        </button>
      </div>
    </section>

    <section class="kpi-grid" aria-label="Ключові показники">
      <button type="button" class="kpi-card" data-nav="code" data-code-tab="pr" data-pr-filter="open">
        <div class="kpi-top">
          <span>Відкриті PR</span>
          <span class="kpi-icon ${readyCount > 0 ? '' : 'is-warn'}">${icon('pr', 16)}</span>
        </div>
        <strong class="kpi-value num">${openPrs.length}</strong>
        <span class="kpi-sub">Готові: ${readyCount} · Чернетки: ${draftCount}</span>
      </button>

      <button type="button" class="kpi-card" data-nav="code" data-code-tab="runs">
        <div class="kpi-top">
          <span>Збірки CI (останні)</span>
          <span class="kpi-icon ${failedRuns > 0 ? 'is-danger' : ''}">${icon('ci', 16)}</span>
        </div>
        <strong class="kpi-value num">${recentRuns.length ? `${passedRuns}/${recentRuns.length}` : '—'}</strong>
        <span class="kpi-sub">${failedRuns > 0 ? `Помилок: ${failedRuns}` : (liveRuns > 0 ? `У роботі зараз: ${liveRuns}` : 'Усі останні збірки зелені')}</span>
      </button>

      <button type="button" class="kpi-card" data-nav="work" data-work-tab="checklist">
        <div class="kpi-top">
          <span>Пункти приймання</span>
          <span class="kpi-icon">${icon('work', 16)}</span>
        </div>
        <strong class="kpi-value num">${totalCheckItems ? `${doneCheckItems}/${totalCheckItems}` : '—'}</strong>
        <span class="kpi-sub">${checklists.length ? `Чеклістів: ${checklists.length}` : 'Додайте чекліст приймання'}</span>
      </button>

      <button type="button" class="kpi-card" data-nav="code" data-code-tab="releases">
        <div class="kpi-top">
          <span>Останній реліз</span>
          <span class="kpi-icon">${icon('tag', 16)}</span>
        </div>
        <strong class="kpi-value mono">${latestRelease ? escapeHtml(latestRelease.tag) : '—'}</strong>
        <span class="kpi-sub">${latestRelease ? `Опубліковано ${formatDateShort(latestRelease.publishedAt)}` : 'Релізів ще немає'}</span>
      </button>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Потребує уваги зараз</h2>
          <small>Автоматичний збір блокерів, активних збірок і відкритих рішень</small>
        </div>
      </div>
      ${attention.length ? `
        <div class="attention-list">
          ${attention.map((item, idx) => `
            <button type="button" class="attention-item tone-${item.tone}" data-attention-idx="${idx}">
              ${icon(item.icon, 18)}
              <span class="attention-body">
                <strong>${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(item.meta)}</small>
              </span>
            </button>
          `).join('')}
        </div>
      ` : `
        <div class="empty-box">Критичних зауважень немає — збірки та відкриті пункти під контролем.</div>
      `}
    </section>

    ${cycle ? renderCycleCard(cycle) : ''}

    <div class="two-col">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Відкриті PR та останні збірки</h2>
            <small>Живий зріз із GitHub</small>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-nav="code" data-code-tab="pr">Усі PR ${icon('arrow', 14)}</button>
        </div>

        <div class="list-stack">
          ${openPrs.length ? openPrs.slice(0, 4).map((pr) => renderPrCompactRow(pr)).join('') : '<div class="empty-box">Відкритих запитів на злиття зараз немає.</div>'}
        </div>

        ${recentRuns.length ? `
          <div class="panel-head" style="margin-top: 6px;">
            <div>
              <h2>Останні запуски Actions</h2>
            </div>
            <button type="button" class="btn btn-sm btn-ghost" data-nav="code" data-code-tab="runs">Усі збірки ${icon('arrow', 14)}</button>
          </div>
          <div class="list-stack">
            ${recentRuns.slice(0, 4).map((run) => renderRunCompactRow(run)).join('')}
          </div>
        ` : ''}
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Наступні кроки</h2>
            <small>План дій до приймання</small>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-nav="work" data-work-tab="next">Усі кроки ${icon('arrow', 14)}</button>
        </div>

        <div class="list-stack">
          ${nextSteps.length ? nextSteps.map((step, index) => `
            <div class="row-card">
              <div class="row-main">
                <button type="button" class="row-title-btn" data-open-record="${escapeHtml(step.id)}">
                  <span class="mono" style="color: var(--accent); margin-right: 6px;">${index + 1}.</span>${escapeHtml(step.title)}
                </button>
                <div class="row-meta">
                  <span>${escapeHtml(step.role || 'Власник')}</span>
                  <span>·</span>
                  <span>${escapeHtml(step.repo || 'EasyWAR')}</span>
                  <span class="pill pill-${statusTone(step.status)}">${escapeHtml(step.status)}</span>
                </div>
              </div>
              <div class="row-side">
                <button type="button" class="btn btn-sm btn-icon btn-ghost" data-edit-record="${escapeHtml(step.id)}" aria-label="Редагувати крок">
                  ${icon('edit', 14)}
                </button>
              </div>
            </div>
          `).join('') : '<div class="empty-box">Незавершених наступних кроків немає.</div>'}
        </div>

        <div class="panel-head" style="margin-top: 6px;">
          <div>
            <h2>Останні коміти</h2>
            <small>Основна гілка репозиторію</small>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-nav="code" data-code-tab="commits">Історія ${icon('arrow', 14)}</button>
        </div>

        <div class="list-stack">
          ${commits.length ? commits.map((commit) => `
            <div class="row-card">
              <div class="row-main">
                <a href="${escapeHtml(safeUrl(commit.url))}" target="_blank" rel="noopener noreferrer" style="color: var(--ink);">
                  ${escapeHtml(commit.message || 'Без опису коміту')}
                </a>
                <div class="row-meta">
                  <button type="button" class="sha-chip" data-copy="${escapeHtml(commit.sha)}" title="Скопіювати повний SHA">
                    ${escapeHtml(shortSha(commit.sha))} ${icon('copy', 12)}
                  </button>
                  <span>${escapeHtml(commit.repo)}</span>
                  <span>·</span>
                  <span>${escapeHtml(commit.author || 'невідомо')}</span>
                  <span>·</span>
                  <span>${escapeHtml(formatRelative(commit.date))}</span>
                </div>
              </div>
            </div>
          `).join('') : '<div class="empty-box">Дані про коміти з’являться після синхронізації з GitHub.</div>'}
        </div>
      </section>
    </div>
  `;
}

function renderCycleCard(cycle) {
  const stages = Array.isArray(cycle.stages) && cycle.stages.length
    ? cycle.stages
    : [
        { label: 'Перевірка CI', done: false },
        { label: 'Рев’ю PR', done: false },
        { label: 'Приймання', done: false },
      ];
  return `
    <section class="cycle-card" aria-label="Поточний цикл контролю">
      <div>
        <div class="cycle-eyebrow">Поточний цикл · ${escapeHtml(cycle.status || 'Активний')}</div>
        <h2>${escapeHtml(cycle.title)}</h2>
        <p>${escapeHtml(cycle.description || '')}</p>
        <div class="cycle-actions">
          <button type="button" class="btn btn-sm" data-nav="work" data-work-tab="checklist">
            ${icon('work', 15)}
            <span>Умови приймання</span>
          </button>
          <button type="button" class="btn btn-sm btn-ghost" data-edit-record="${escapeHtml(cycle.id)}">
            ${icon('edit', 14)}
            <span>Змінити фокус</span>
          </button>
        </div>
      </div>

      <div class="stage-stepper">
        ${stages.map((stage, idx) => `
          <button type="button" class="stage-step ${stage.done ? 'is-done' : ''}" data-toggle-stage="${escapeHtml(cycle.id)}:${idx}" aria-pressed="${Boolean(stage.done)}">
            <span class="stage-dot">${icon(stage.done ? 'check' : (idx === 1 ? 'pr' : 'shield'), 16)}</span>
            <span>${escapeHtml(stage.label)}</span>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderPrCompactRow(pr) {
  const prState = translatePrState(pr);
  const checksSummary = summarizeChecks(pr.checks);
  return `
    <div class="row-card">
      <div class="row-main">
        <button type="button" class="row-title-btn" data-open-pr="${escapeHtml(pr.repo)}:${pr.number}">
          ${escapeHtml(pr.title)}
        </button>
        <div class="row-meta">
          <span class="mono">#${pr.number}</span>
          <span>·</span>
          <span>${escapeHtml(pr.repo)}</span>
          <button type="button" class="sha-chip" data-copy="${escapeHtml(pr.sha)}" title="Скопіювати HEAD SHA">
            ${escapeHtml(shortSha(pr.sha))} ${icon('copy', 12)}
          </button>
          ${renderDiffStat(pr)}
        </div>
      </div>
      <div class="row-side">
        <span class="pill pill-${checksSummary.tone}">${escapeHtml(checksSummary.label)}</span>
        <span class="pill pill-${prState.tone}">${escapeHtml(prState.label)}</span>
      </div>
    </div>
  `;
}

function renderRunCompactRow(run) {
  const st = translateCiStatus(run.status, run.conclusion);
  const url = safeUrl(run.url);
  return `
    <div class="row-card">
      <div class="row-main">
        ${url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color: var(--ink);">${escapeHtml(run.displayTitle || run.name)}</a>`
          : `<span>${escapeHtml(run.displayTitle || run.name)}</span>`}
        <div class="row-meta">
          <span>${escapeHtml(run.name)}</span>
          <span>·</span>
          <span class="mono">${escapeHtml(run.branch || '—')}</span>
          <span>·</span>
          <span>${escapeHtml(formatRelative(run.createdAt))}</span>
        </div>
      </div>
      <div class="row-side">
        <span class="pill pill-${st.tone}">${escapeHtml(st.label)}</span>
      </div>
    </div>
  `;
}

function summarizeChecks(checks) {
  if (!Array.isArray(checks) || !checks.length) {
    return { label: 'Без CI', tone: 'neutral' };
  }
  const translated = checks.map((c) => translateCiStatus(c.status, c.conclusion));
  if (translated.some((t) => t.tone === 'danger')) {
    return { label: 'Помилка CI', tone: 'danger' };
  }
  if (translated.some((t) => t.tone === 'live' || t.tone === 'warn')) {
    return { label: 'CI триває', tone: 'live' };
  }
  const okCount = translated.filter((t) => t.tone === 'good').length;
  return { label: `CI ${okCount}/${checks.length}`, tone: okCount === checks.length ? 'good' : 'neutral' };
}

function renderDiffStat(pr) {
  if (pr.additions == null && pr.deletions == null) return '';
  return `
    <span class="diff-stat num">
      <span class="diff-add">+${formatNumber(pr.additions || 0)}</span>
      <span class="diff-del">-${formatNumber(pr.deletions || 0)}</span>
      ${pr.changedFiles != null ? `<span class="diff-files">· ${formatNumber(pr.changedFiles)} ф.</span>` : ''}
    </span>
  `;
}

/* ===== View 2: Код і релізи ===== */
function renderCodeView() {
  const pulls = scopedPulls();
  const runs = scopedRuns();
  const commits = scopedCommits();
  const branches = scopedBranches();
  const releases = scopedReleases();

  const tabs = [
    { id: 'pr', label: 'Запити на злиття', icon: 'pr', count: pulls.filter((p) => p.state === 'open').length },
    { id: 'runs', label: 'Збірки CI', icon: 'ci', count: runs.length },
    { id: 'commits', label: 'Коміти', icon: 'commit', count: commits.length },
    { id: 'branches', label: 'Гілки', icon: 'branch', count: branches.length },
    { id: 'releases', label: 'Релізи', icon: 'tag', count: releases.length },
  ];

  const q = state.codeQuery.trim().toLocaleLowerCase('uk');

  let bodyHtml = '';
  if (state.codeTab === 'pr') {
    const filtered = pulls.filter((pr) => {
      if (state.codePrFilter === 'open' && pr.state !== 'open') return false;
      if (state.codePrFilter === 'draft' && !(pr.state === 'open' && pr.draft)) return false;
      if (state.codePrFilter === 'merged' && !pr.merged) return false;
      if (!q) return true;
      return `${pr.number} ${pr.title} ${pr.head} ${pr.base} ${pr.sha} ${pr.author} ${pr.repo}`.toLocaleLowerCase('uk').includes(q);
    });
    bodyHtml = `
      <div class="filter-bar">
        <input class="input" type="search" placeholder="Пошук PR за номером, назвою, гілкою або SHA…" value="${escapeHtml(state.codeQuery)}" data-bind="codeQuery">
        <select class="select" data-bind="codePrFilter" aria-label="Стан PR">
          <option value="open" ${state.codePrFilter === 'open' ? 'selected' : ''}>Відкриті</option>
          <option value="draft" ${state.codePrFilter === 'draft' ? 'selected' : ''}>Лише чернетки</option>
          <option value="merged" ${state.codePrFilter === 'merged' ? 'selected' : ''}>Злиті</option>
          <option value="all" ${state.codePrFilter === 'all' ? 'selected' : ''}>Усі PR</option>
        </select>
      </div>
      ${filtered.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>PR</th>
                <th>Гілки та зміни</th>
                <th>HEAD SHA</th>
                <th>CI</th>
                <th>Стан</th>
                <th>Оновлено</th>
                <th><span class="sr-only">Дії</span></th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map((pr) => {
                const st = translatePrState(pr);
                const ci = summarizeChecks(pr.checks);
                const url = safeUrl(pr.url);
                return `
                  <tr>
                    <td>
                      <button type="button" class="row-title-btn" data-open-pr="${escapeHtml(pr.repo)}:${pr.number}">
                        <strong>#${pr.number}</strong> ${escapeHtml(pr.title)}
                      </button>
                      <div class="row-meta" style="margin-top: 3px;">
                        <span>${escapeHtml(pr.repo)}</span>
                        ${pr.author ? `<span>· ${escapeHtml(pr.author)}</span>` : ''}
                      </div>
                    </td>
                    <td>
                      <div class="mono" style="font-size: 12px;">${escapeHtml(pr.head)} → ${escapeHtml(pr.base)}</div>
                      <div style="margin-top: 4px;">${renderDiffStat(pr)}</div>
                    </td>
                    <td>
                      <button type="button" class="sha-chip" data-copy="${escapeHtml(pr.sha)}">
                        ${escapeHtml(shortSha(pr.sha))} ${icon('copy', 12)}
                      </button>
                    </td>
                    <td><span class="pill pill-${ci.tone}">${escapeHtml(ci.label)}</span></td>
                    <td><span class="pill pill-${st.tone}">${escapeHtml(st.label)}</span></td>
                    <td class="num" style="white-space: nowrap; color: var(--muted);">${escapeHtml(formatDateTime(pr.updatedAt))}</td>
                    <td style="white-space: nowrap;">
                      ${url ? `<a class="btn btn-sm btn-icon btn-ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Відкрити на GitHub">${icon('outbound', 14)}</a>` : ''}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-box">За вибраним фільтром PR не знайдено.</div>'}
    `;
  } else if (state.codeTab === 'runs') {
    const filtered = runs.filter((run) => {
      if (!q) return true;
      return `${run.name} ${run.displayTitle} ${run.branch} ${run.sha} ${run.repo}`.toLocaleLowerCase('uk').includes(q);
    });
    bodyHtml = `
      <div class="filter-bar">
        <input class="input" type="search" placeholder="Пошук збірок за назвою workflow, гілкою або SHA…" value="${escapeHtml(state.codeQuery)}" data-bind="codeQuery">
      </div>
      ${filtered.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Запуск</th>
                <th>Гілка / тег</th>
                <th>Подія</th>
                <th>Статус</th>
                <th>Час</th>
                <th><span class="sr-only">Посилання</span></th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map((run) => {
                const st = translateCiStatus(run.status, run.conclusion);
                const url = safeUrl(run.url);
                return `
                  <tr>
                    <td>
                      <div>${escapeHtml(run.displayTitle || run.name)}</div>
                      <div class="row-meta" style="margin-top: 3px;">
                        <span>${escapeHtml(run.repo)}</span>
                        <span>·</span>
                        <span>${escapeHtml(run.name)}</span>
                      </div>
                    </td>
                    <td>
                      <div class="mono" style="font-size: 12px;">${escapeHtml(run.branch || '—')}</div>
                      <button type="button" class="sha-chip" style="margin-top: 4px;" data-copy="${escapeHtml(run.sha)}">
                        ${escapeHtml(shortSha(run.sha))} ${icon('copy', 12)}
                      </button>
                    </td>
                    <td style="color: var(--muted);">${escapeHtml(translateEvent(run.event))}</td>
                    <td><span class="pill pill-${st.tone}">${escapeHtml(st.label)}</span></td>
                    <td class="num" style="white-space: nowrap; color: var(--muted);">${escapeHtml(formatDateTime(run.createdAt))}</td>
                    <td>
                      ${url ? `<a class="btn btn-sm btn-icon btn-ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Логи на GitHub">${icon('outbound', 14)}</a>` : ''}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-box">Запусків GitHub Actions не знайдено.</div>'}
    `;
  } else if (state.codeTab === 'commits') {
    const filtered = commits.filter((c) => {
      if (!q) return true;
      return `${c.message} ${c.author} ${c.sha} ${c.repo}`.toLocaleLowerCase('uk').includes(q);
    });
    bodyHtml = `
      <div class="filter-bar">
        <input class="input" type="search" placeholder="Пошук комітів за описом, автором або SHA…" value="${escapeHtml(state.codeQuery)}" data-bind="codeQuery">
      </div>
      ${filtered.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>SHA</th>
                <th>Опис коміту</th>
                <th>Автор</th>
                <th>Дата (Київ)</th>
                <th><span class="sr-only">Посилання</span></th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map((c) => {
                const url = safeUrl(c.url);
                return `
                  <tr>
                    <td>
                      <button type="button" class="sha-chip" data-copy="${escapeHtml(c.sha)}">
                        ${escapeHtml(shortSha(c.sha))} ${icon('copy', 12)}
                      </button>
                    </td>
                    <td>
                      <div>${escapeHtml(c.message)}</div>
                      <div class="row-meta" style="margin-top: 3px;"><span>${escapeHtml(c.repo)} · ${escapeHtml(c.branch)}</span></div>
                    </td>
                    <td style="color: var(--muted);">${escapeHtml(c.author || '—')}</td>
                    <td class="num" style="white-space: nowrap; color: var(--muted);">${escapeHtml(formatDateTime(c.date))}</td>
                    <td>
                      ${url ? `<a class="btn btn-sm btn-icon btn-ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Відкрити коміт">${icon('outbound', 14)}</a>` : ''}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-box">Комітів не знайдено.</div>'}
    `;
  } else if (state.codeTab === 'branches') {
    const filtered = branches.filter((b) => {
      if (!q) return true;
      return `${b.branch} ${b.sha} ${b.repo}`.toLocaleLowerCase('uk').includes(q);
    });
    bodyHtml = `
      <div class="filter-bar">
        <input class="input" type="search" placeholder="Пошук гілок за назвою або SHA…" value="${escapeHtml(state.codeQuery)}" data-bind="codeQuery">
      </div>
      ${filtered.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Гілка</th>
                <th>Репозиторій</th>
                <th>HEAD SHA</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map((b) => `
                <tr>
                  <td>
                    <button type="button" class="row-title-btn mono" data-copy="${escapeHtml(b.branch)}" title="Натисніть, щоб скопіювати назву гілки">
                      ${escapeHtml(b.branch)}
                    </button>
                  </td>
                  <td style="color: var(--muted);">${escapeHtml(b.repo)}</td>
                  <td>
                    <button type="button" class="sha-chip" data-copy="${escapeHtml(b.sha)}">
                      ${escapeHtml(shortSha(b.sha))} ${icon('copy', 12)}
                    </button>
                  </td>
                  <td>
                    ${b.default ? '<span class="pill pill-good">Основна</span>' : '<span class="pill pill-neutral">Робоча</span>'}
                    ${b.protected ? '<span class="pill pill-live" style="margin-left: 6px;">Захищена</span>' : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-box">Гілок не знайдено.</div>'}
    `;
  } else if (state.codeTab === 'releases') {
    const filtered = releases.filter((r) => {
      if (!q) return true;
      return `${r.tag} ${r.name} ${r.repo}`.toLocaleLowerCase('uk').includes(q);
    });
    bodyHtml = `
      <div class="filter-bar">
        <input class="input" type="search" placeholder="Пошук релізів за версією або назвою…" value="${escapeHtml(state.codeQuery)}" data-bind="codeQuery">
      </div>
      ${filtered.length ? `
        <div class="card-grid">
          ${filtered.map((rel) => {
            const url = safeUrl(rel.url);
            return `
              <article class="work-card">
                <div class="work-card-head">
                  <div>
                    <h3 class="mono">${escapeHtml(rel.tag)}</h3>
                    <div class="row-meta" style="margin-top: 4px;">
                      <span>${escapeHtml(rel.repo)}</span>
                      <span>·</span>
                      <span>${escapeHtml(formatDateTime(rel.publishedAt))}</span>
                    </div>
                  </div>
                  <div class="row-side">
                    ${rel.prerelease ? '<span class="pill pill-warn">Попередній</span>' : '<span class="pill pill-good">Реліз</span>'}
                    ${url ? `<a class="btn btn-sm btn-icon btn-ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Відкрити реліз на GitHub">${icon('outbound', 14)}</a>` : ''}
                  </div>
                </div>
                ${rel.name && rel.name !== rel.tag ? `<p>${escapeHtml(rel.name)}</p>` : ''}
                ${rel.assets?.length ? `
                  <div class="list-stack">
                    ${rel.assets.slice(0, 6).map((asset) => `
                      <div class="row-meta" style="justify-content: space-between; padding: 5px 8px; background: var(--surface-inset); border-radius: 6px; border: 1px solid var(--line);">
                        <span class="mono" style="color: var(--ink); overflow: hidden; text-overflow: ellipsis;">${escapeHtml(asset.name)}</span>
                        <span class="num">${escapeHtml(formatBytes(asset.size))}</span>
                      </div>
                    `).join('')}
                  </div>
                ` : '<small style="color: var(--subtle);">Файли збірки не прикріплено.</small>'}
              </article>
            `;
          }).join('')}
        </div>
      ` : '<div class="empty-box">Опублікованих релізів поки не знайдено.</div>'}
    `;
  }

  return `
    <section class="page-head">
      <div>
        <h1>Код і релізи</h1>
        <p>Повний read-only зріз репозиторію з GitHub: PR, збірки CI, коміти, гілки та версії</p>
      </div>
    </section>

    <section class="panel">
      <div class="subtabs" role="tablist" aria-label="Підрозділи коду">
        ${tabs.map((tab) => `
          <button type="button" class="subtab ${state.codeTab === tab.id ? 'is-active' : ''}" role="tab" aria-selected="${state.codeTab === tab.id}" data-code-tab-switch="${tab.id}">
            ${icon(tab.icon, 15)}
            <span>${escapeHtml(tab.label)}</span>
            <span class="subtab-count num">${tab.count}</span>
          </button>
        `).join('')}
      </div>
      ${bodyHtml}
    </section>
  `;
}

/* ===== View 3: Екрани й збірки ===== */
function renderScreensView() {
  const liveScreens = (state.live.screens || []).filter((s) => matchesRepo(s.repo));
  const localScreens = (state.localScreens || []).filter((s) => matchesRepo(s.repo));

  const localPrepared = localScreens.map((item) => {
    const url = item.blob ? URL.createObjectURL(item.blob) : '';
    if (url) blobUrls.push(url);
    return { ...item, src: url };
  });

  return `
    <section class="page-head">
      <div>
        <h1>Екрани й збірки EasyWAR</h1>
        <p>Візуальна перевірка екранів із GitHub Actions, власні локальні знімки та базовий орієнтир інтерфейсу</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Локальні знімки перевірки</h2>
          <small>Зберігаються лише в браузері (IndexedDB) — зручно фіксувати скріни нової збірки чи PR</small>
        </div>
      </div>

      <div id="screen-dropzone" class="upload-zone">
        <div class="upload-fields">
          <input id="screen-ref-input" class="input" type="text" placeholder="Версія або PR (напр. v2.3.1 або #248)" style="flex: 1 1 200px;">
          <input id="screen-sha-input" class="input mono" type="text" placeholder="SHA (необов’язково)" style="flex: 0 1 180px;">
        </div>
        <div>
          <label class="btn btn-primary" for="screen-file-input">
            ${icon('upload', 15)}
            <span>Додати PNG / JPEG / WebP</span>
          </label>
          <input id="screen-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
        </div>
      </div>

      ${localPrepared.length ? `
        <div class="screen-grid">
          ${localPrepared.map((scr, idx) => `
            <article class="screen-card">
              <button type="button" class="screen-thumb" data-open-lightbox="local:${idx}">
                <img src="${escapeHtml(scr.src)}" alt="${escapeHtml(scr.title)}" loading="lazy">
              </button>
              <div class="screen-meta">
                <div style="min-width: 0;">
                  <strong>${escapeHtml(scr.title)}</strong>
                  <small>${escapeHtml(scr.refLabel || scr.repo)}${scr.sha ? ` · ${escapeHtml(shortSha(scr.sha))}` : ''} · ${escapeHtml(formatDateTime(scr.createdAt))}</small>
                </div>
                <button type="button" class="btn btn-sm btn-icon btn-ghost" data-delete-screen="${escapeHtml(scr.id)}" title="Видалити знімок">
                  ${icon('trash', 14)}
                </button>
              </div>
            </article>
          `).join('')}
        </div>
      ` : '<div class="empty-box">Локальних знімків ще немає. Перетягніть файли сюди або натисніть «Додати PNG / JPEG / WebP».</div>'}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Знімки з GitHub Actions (${liveScreens.length})</h2>
          <small>Підтягуються автоматично, якщо workflow публікує артефакт easywar-screens-&lt;платформа&gt;</small>
        </div>
      </div>
      ${liveScreens.length ? `
        <div class="screen-grid">
          ${liveScreens.map((scr, idx) => `
            <article class="screen-card">
              <button type="button" class="screen-thumb" data-open-lightbox="live:${idx}">
                <img src="${escapeHtml(scr.src)}" alt="${escapeHtml(scr.title)}" loading="lazy">
              </button>
              <div class="screen-meta">
                <div>
                  <strong>${escapeHtml(scr.title)}</strong>
                  <small>${escapeHtml(scr.platform)} · ${escapeHtml(shortSha(scr.sha))} · ${escapeHtml(formatDateTime(scr.createdAt))}</small>
                </div>
              </div>
            </article>
          `).join('')}
        </div>
      ` : '<div class="empty-box">Артефактів easywar-screens-* у GitHub Actions зараз не знайдено.</div>'}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Базові екрани EasyWAR (${BUNDLED_SCREENS.length})</h2>
          <small>Опорний знімок основних модулів для швидкого візуального звіряння</small>
        </div>
      </div>
      <div class="screen-grid">
        ${BUNDLED_SCREENS.map((scr, idx) => `
          <article class="screen-card">
            <button type="button" class="screen-thumb" data-open-lightbox="bundled:${idx}">
              <img src="${escapeHtml(scr.src)}" alt="${escapeHtml(scr.title)}" loading="lazy">
            </button>
            <div class="screen-meta">
              <div>
                <strong>${escapeHtml(scr.title)}</strong>
                <small>${escapeHtml(scr.group)}</small>
              </div>
            </div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

/* ===== View 4: Приймання й задачі ===== */
function renderWorkView() {
  const workKindSet = new Set(WORK_KINDS.map((k) => k.key));
  const allWork = scopedRecords().filter((r) => workKindSet.has(r.kind));

  const q = state.workQuery.trim().toLocaleLowerCase('uk');
  const filtered = allWork.filter((item) => {
    if (state.workTab !== 'all' && item.kind !== state.workTab) return false;
    if (state.workStatus && item.status !== state.workStatus) return false;
    if (state.workRole && item.role !== state.workRole) return false;
    if (!q) return true;
    const checkText = (item.items || []).map((i) => i.text).join(' ');
    return `${item.title} ${item.description || ''} ${item.prRef || ''} ${item.role || ''} ${checkText}`.toLocaleLowerCase('uk').includes(q);
  });

  const allStatuses = [...new Set(allWork.map((i) => i.status).filter(Boolean))];

  return `
    <section class="page-head">
      <div>
        <h1>Приймання й задачі</h1>
        <p>Чеклісти приймання, завдання, рішення, відкриті питання та наступні кроки в одному місці</p>
      </div>
      <div class="page-head-actions">
        <button type="button" class="btn btn-primary" data-action="open-create-menu">
          ${icon('add', 16)}
          <span>Створити запис</span>
        </button>
      </div>
    </section>

    <section class="panel">
      <div class="subtabs" role="tablist" aria-label="Категорії записів">
        <button type="button" class="subtab ${state.workTab === 'all' ? 'is-active' : ''}" data-work-tab-switch="all">
          <span>Усі</span>
          <span class="subtab-count num">${allWork.length}</span>
        </button>
        ${WORK_KINDS.map((k) => {
          const count = allWork.filter((r) => r.kind === k.key).length;
          return `
            <button type="button" class="subtab ${state.workTab === k.key ? 'is-active' : ''}" data-work-tab-switch="${k.key}">
              ${icon(k.icon, 15)}
              <span>${escapeHtml(k.plural)}</span>
              <span class="subtab-count num">${count}</span>
            </button>
          `;
        }).join('')}
      </div>

      <div class="filter-bar">
        <input class="input" type="search" placeholder="Пошук за назвою, описом, PR або пунктом чекліста…" value="${escapeHtml(state.workQuery)}" data-bind="workQuery">
        <select class="select" data-bind="workStatus" aria-label="Фільтр за статусом">
          <option value="">Усі статуси</option>
          ${allStatuses.map((s) => `<option value="${escapeHtml(s)}" ${state.workStatus === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <select class="select" data-bind="workRole" aria-label="Фільтр за роллю">
          <option value="">Усі ролі</option>
          ${ROLE_OPTIONS.map((r) => `<option value="${escapeHtml(r)}" ${state.workRole === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
        </select>
        ${(state.workQuery || state.workStatus || state.workRole) ? '<button type="button" class="btn btn-sm btn-ghost" data-action="reset-work-filters">Скинути</button>' : ''}
      </div>

      ${filtered.length ? `
        <div class="card-grid">
          ${filtered.map((item) => renderWorkCard(item)).join('')}
        </div>
      ` : '<div class="empty-box">Записів за цим фільтром немає. Натисніть «Створити запис», щоб додати новий.</div>'}
    </section>
  `;
}

function renderWorkCard(item) {
  const meta = WORK_KINDS.find((k) => k.key === item.kind) || { label: item.kind, icon: 'file' };
  let checklistHtml = '';
  if (item.kind === 'checklist') {
    const list = Array.isArray(item.items) ? item.items : [];
    const done = list.filter((i) => i.done).length;
    const pct = list.length ? Math.round((done / list.length) * 100) : 0;
    checklistHtml = `
      <div class="progress-row num">
        <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
        <span>${done} із ${list.length}</span>
      </div>
      ${list.length ? `
        <ul class="check-list">
          ${list.map((entry, idx) => `
            <li class="check-item ${entry.done ? 'is-done' : ''}">
              <label>
                <input type="checkbox" ${entry.done ? 'checked' : ''} data-toggle-check="${escapeHtml(item.id)}:${idx}">
                <span>${escapeHtml(entry.text)}</span>
              </label>
            </li>
          `).join('')}
        </ul>
      ` : '<small style="color: var(--subtle);">Додайте пункти перевірки у редакторі.</small>'}
    `;
  }

  return `
    <article class="work-card">
      <div class="work-card-head">
        <div>
          <div class="row-meta" style="margin-bottom: 5px;">
            <span class="pill pill-neutral">${icon(meta.icon, 12)} ${escapeHtml(meta.label)}</span>
            <span class="pill pill-${statusTone(item.status)}">${escapeHtml(item.status)}</span>
          </div>
          <h3>
            <button type="button" class="row-title-btn" data-open-record="${escapeHtml(item.id)}">
              ${escapeHtml(item.title)}
            </button>
          </h3>
        </div>
        <div class="row-side">
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-edit-record="${escapeHtml(item.id)}" title="Редагувати">
            ${icon('edit', 14)}
          </button>
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-delete-record="${escapeHtml(item.id)}" title="Видалити">
            ${icon('trash', 14)}
          </button>
        </div>
      </div>

      ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
      ${checklistHtml}

      <div class="row-meta" style="margin-top: auto; padding-top: 6px; border-top: 1px solid var(--line);">
        <span>${escapeHtml(item.repo || 'EasyWAR')}</span>
        <span>·</span>
        <span>${escapeHtml(item.role || 'Власник')}</span>
        ${item.prRef ? `<span>·</span><span class="mono" style="color: var(--accent);">${escapeHtml(item.prRef)}</span>` : ''}
        <span style="margin-left: auto;">${escapeHtml(formatDateShort(item.updatedAt))}</span>
      </div>
    </article>
  `;
}

/* ===== View 5: Агенти й журнал ===== */
function renderAgentsView() {
  const budgets = scopedRecords('budget');
  const logs = scopedRecords('log').sort((a, b) => (b.date || b.updatedAt || '').localeCompare(a.date || a.updatedAt || ''));
  const tasks = state.agentTasks.filter((t) => matchesRepo(t.repo));

  const editingTask = state.editingAgentTaskId
    ? state.agentTasks.find((t) => t.id === state.editingAgentTaskId) || null
    : null;
  const prefill = editingTask || state.agentDraftPrefill || {
    title: '',
    role: 'J5',
    repo: state.repoScope === 'ALL' ? 'EasyWAR' : state.repoScope,
    prRef: '',
    sha: '',
    status: AGENT_STATUSES[0],
    instruction: '',
    result: '',
  };

  let bodyHtml = '';
  if (state.agentsTab === 'tasks') {
    bodyHtml = `
      <div class="agent-grid">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>${editingTask ? 'Редагування доручення' : 'Нове доручення агенту'}</h2>
              <small>Зберігається локально в SQLite; виконання лише вручну через копіювання промпта</small>
            </div>
          </div>

          <form id="agent-task-form" class="form-stack">
            <div class="field">
              <label for="at-title">Назва завдання</label>
              <input id="at-title" name="title" class="input" required maxlength="160" value="${escapeHtml(prefill.title)}" placeholder="Наприклад: Перевірити регресію в PR #248">
            </div>

            <div class="field-row">
              <div class="field">
                <label for="at-role">Роль</label>
                <select id="at-role" name="role" class="select">
                  ${AGENT_ROLES.map((r) => `<option value="${escapeHtml(r)}" ${prefill.role === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label for="at-repo">Репозиторій</label>
                <select id="at-repo" name="repo" class="select">
                  ${configuredRepos().map((r) => `<option value="${escapeHtml(r)}" ${prefill.repo === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="field-row">
              <div class="field">
                <label for="at-pr">PR або гілка (необов’язково)</label>
                <input id="at-pr" name="prRef" class="input mono" maxlength="64" value="${escapeHtml(prefill.prRef || '')}" placeholder="#248 або main">
              </div>
              <div class="field">
                <label for="at-sha">SHA коміту (необов’язково)</label>
                <input id="at-sha" name="sha" class="input mono" maxlength="40" value="${escapeHtml(prefill.sha || '')}" placeholder="7–40 hex-символів">
              </div>
            </div>

            <div class="field">
              <label for="at-status">Статус</label>
              <select id="at-status" name="status" class="select">
                ${AGENT_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${prefill.status === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
              </select>
            </div>

            <div class="field">
              <label for="at-instruction">Інструкція агенту</label>
              <textarea id="at-instruction" name="instruction" class="textarea" required maxlength="5000" placeholder="Опишіть чіткі межі задачі, файли та критерії перевірки…">${escapeHtml(prefill.instruction)}</textarea>
            </div>

            <div class="field">
              <label for="at-result">Результат / нотатка після перевірки</label>
              <textarea id="at-result" name="result" class="textarea" style="min-height: 64px;" maxlength="10000" placeholder="Заповнюється після виконання">${escapeHtml(prefill.result || '')}</textarea>
            </div>

            <div id="agent-form-error" class="form-error" hidden></div>

            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button type="submit" class="btn btn-primary" ${state.serverOnline ? '' : 'disabled'}>
                ${icon('check', 15)}
                <span>${editingTask ? 'Зберегти зміни' : 'Зберегти чернетку'}</span>
              </button>
              ${(editingTask || state.agentDraftPrefill) ? '<button type="button" class="btn btn-ghost" data-action="cancel-agent-edit">Скасувати</button>' : ''}
            </div>
            ${!state.serverOnline ? '<small style="color: var(--warn);">Потрібен запущений локальний сервер Mac для збереження доручень у SQLite.</small>' : ''}
          </form>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Збережені доручення (${tasks.length})</h2>
              <small>Натисніть «Скопіювати промпт», щоб передати завдання з правилами безпеки AGENTS.md</small>
            </div>
          </div>

          ${tasks.length ? `
            <div class="list-stack">
              ${tasks.map((task) => `
                <article class="work-card" style="padding: 14px 16px;">
                  <div class="work-card-head">
                    <div>
                      <div class="row-meta" style="margin-bottom: 5px;">
                        <span class="pill pill-neutral">${escapeHtml(task.role)}</span>
                        <span class="pill pill-${statusTone(task.status)}">${escapeHtml(task.status)}</span>
                        <span>${escapeHtml(task.repo)}</span>
                        ${task.prRef ? `<span class="mono" style="color: var(--accent);">${escapeHtml(task.prRef)}</span>` : ''}
                        ${task.sha ? `<span class="mono">${escapeHtml(shortSha(task.sha))}</span>` : ''}
                      </div>
                      <h3>${escapeHtml(task.title)}</h3>
                    </div>
                    <div class="row-side">
                      <button type="button" class="btn btn-sm" data-copy-agent-task="${escapeHtml(task.id)}">
                        ${icon('copy', 13)}
                        <span>Промпт</span>
                      </button>
                      <button type="button" class="btn btn-sm btn-icon btn-ghost" data-edit-agent-task="${escapeHtml(task.id)}" title="Редагувати">
                        ${icon('edit', 14)}
                      </button>
                      <button type="button" class="btn btn-sm btn-icon btn-ghost" data-delete-agent-task="${escapeHtml(task.id)}" title="Видалити">
                        ${icon('trash', 14)}
                      </button>
                    </div>
                  </div>
                  <p style="white-space: pre-wrap;">${escapeHtml(task.instruction)}</p>
                  ${task.result ? `<div style="padding: 8px 10px; border-radius: 6px; background: var(--surface-inset); border: 1px solid var(--line); font-size: 12.5px; color: var(--muted);"><strong>Результат:</strong> ${escapeHtml(task.result)}</div>` : ''}
                  <div class="row-meta">
                    <span>Створено ${escapeHtml(formatDateTime(task.createdAt))}</span>
                  </div>
                </article>
              `).join('')}
            </div>
          ` : '<div class="empty-box">Доручень ще немає. Створіть чернетку зліва або з панелі будь-якого PR.</div>'}
        </section>
      </div>
    `;
  } else if (state.agentsTab === 'budgets') {
    bodyHtml = `
      <div class="panel-head">
        <div>
          <h2>Бюджети й ліміти</h2>
          <small>Ручний контроль лімітів витрат і порогів попередження</small>
        </div>
        <button type="button" class="btn btn-sm btn-primary" data-create-kind="budget">
          ${icon('add', 14)}
          <span>Новий ліміт</span>
        </button>
      </div>
      ${budgets.length ? `
        <div class="card-grid">
          ${budgets.map((b) => {
            const limit = Number(b.limit);
            const used = Number(b.used);
            const hasNums = Number.isFinite(limit) && limit > 0 && Number.isFinite(used);
            const remaining = hasNums ? limit - used : null;
            const pct = hasNums ? Math.round((used / limit) * 100) : 0;
            const barClass = pct >= 100 ? 'is-danger' : (pct >= 75 ? 'is-warn' : '');
            const unit = b.unit || 'USD';
            const fmtVal = (v) => (v == null ? '—' : (unit === 'USD' ? `$${formatNumber(v)}` : `${formatNumber(v)} ${unit}`));
            return `
              <article class="work-card">
                <div class="work-card-head">
                  <div>
                    <span class="pill pill-${statusTone(b.status)}">${escapeHtml(b.status)}</span>
                    <h3 style="margin-top: 6px;">${escapeHtml(b.title)}</h3>
                  </div>
                  <div class="row-side">
                    <button type="button" class="btn btn-sm btn-icon btn-ghost" data-edit-record="${escapeHtml(b.id)}" title="Редагувати">${icon('edit', 14)}</button>
                    <button type="button" class="btn btn-sm btn-icon btn-ghost" data-delete-record="${escapeHtml(b.id)}" title="Видалити">${icon('trash', 14)}</button>
                  </div>
                </div>
                <div class="budget-nums num">
                  <div class="budget-metric"><small>Ліміт</small><strong>${escapeHtml(fmtVal(hasNums ? limit : null))}</strong></div>
                  <div class="budget-metric"><small>Використано</small><strong>${escapeHtml(fmtVal(hasNums ? used : null))}</strong></div>
                  <div class="budget-metric"><small>Залишок</small><strong>${escapeHtml(fmtVal(remaining))}</strong></div>
                </div>
                ${hasNums ? `
                  <div class="progress-row num">
                    <div class="progress-bar"><div class="progress-fill ${barClass}" style="width: ${Math.min(100, Math.max(0, pct))}%"></div></div>
                    <span>${pct}%</span>
                  </div>
                ` : ''}
                ${b.thresholds ? `<small style="color: var(--subtle);">${escapeHtml(b.thresholds)}</small>` : ''}
                ${b.description ? `<p>${escapeHtml(b.description)}</p>` : ''}
              </article>
            `;
          }).join('')}
        </div>
      ` : '<div class="empty-box">Лімітів ще не додано.</div>'}
    `;
  } else {
    const lq = state.logQuery.trim().toLocaleLowerCase('uk');
    const filteredLogs = logs.filter((l) => !lq || `${l.title} ${l.description || ''} ${l.repo || ''}`.toLocaleLowerCase('uk').includes(lq));
    bodyHtml = `
      <div class="panel-head">
        <div>
          <h2>Журнал оновлень (${filteredLogs.length})</h2>
          <small>Усі дати показано за київським часом (Europe/Kyiv)</small>
        </div>
        <button type="button" class="btn btn-sm btn-primary" data-create-kind="log">
          ${icon('add', 14)}
          <span>Запис у журнал</span>
        </button>
      </div>
      <div class="filter-bar">
        <input class="input" type="search" placeholder="Пошук по журналу подій…" value="${escapeHtml(state.logQuery)}" data-bind="logQuery">
      </div>
      ${filteredLogs.length ? `
        <div class="list-stack">
          ${filteredLogs.map((entry) => `
            <div class="row-card">
              <div class="row-main">
                <button type="button" class="row-title-btn" data-open-record="${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</button>
                ${entry.description ? `<div style="font-size: 12.5px; color: var(--muted);">${escapeHtml(entry.description)}</div>` : ''}
                <div class="row-meta">
                  <span class="num">${escapeHtml(formatDateTime(entry.date || entry.updatedAt))}</span>
                  <span>·</span>
                  <span>${escapeHtml(entry.repo || 'EasyWAR')}</span>
                  <span class="pill pill-${statusTone(entry.status)}">${escapeHtml(entry.status || 'Зафіксовано')}</span>
                </div>
              </div>
              <div class="row-side">
                <button type="button" class="btn btn-sm btn-icon btn-ghost" data-edit-record="${escapeHtml(entry.id)}" title="Редагувати">${icon('edit', 14)}</button>
                <button type="button" class="btn btn-sm btn-icon btn-ghost" data-delete-record="${escapeHtml(entry.id)}" title="Видалити">${icon('trash', 14)}</button>
              </div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty-box">Подій у журналі не знайдено.</div>'}
    `;
  }

  return `
    <section class="page-head">
      <div>
        <h1>Агенти й журнал</h1>
        <p>Координація доручень агентам, контроль бюджетів та повна хронологія дій</p>
      </div>
    </section>

    <section class="panel">
      <div class="subtabs" role="tablist">
        <button type="button" class="subtab ${state.agentsTab === 'tasks' ? 'is-active' : ''}" data-agents-tab-switch="tasks">
          ${icon('agents', 15)}
          <span>Доручення агентам</span>
          <span class="subtab-count num">${tasks.length}</span>
        </button>
        <button type="button" class="subtab ${state.agentsTab === 'budgets' ? 'is-active' : ''}" data-agents-tab-switch="budgets">
          ${icon('budget', 15)}
          <span>Бюджети й ліміти</span>
          <span class="subtab-count num">${budgets.length}</span>
        </button>
        <button type="button" class="subtab ${state.agentsTab === 'log' ? 'is-active' : ''}" data-agents-tab-switch="log">
          ${icon('log', 15)}
          <span>Журнал оновлень</span>
          <span class="subtab-count num">${logs.length}</span>
        </button>
      </div>
      ${bodyHtml}
    </section>
  `;
}

/* ===== Dialogs: PR Detail, Record Detail, Editor, Search, Lightbox ===== */
function openPrDetail(repo, number) {
  const pr = (state.live.pulls || []).find((p) => p.repo === repo && p.number === Number(number));
  if (!pr) return;
  const prState = translatePrState(pr);
  const url = safeUrl(pr.url);
  const related = state.records.filter((r) => (r.prRef || '').includes(`#${pr.number}`));

  drawerDialog.innerHTML = `
    <div class="drawer-inner">
      <div class="dialog-head">
        <div>
          <div class="row-meta" style="margin-bottom: 6px;">
            <span class="pill pill-${prState.tone}">${escapeHtml(prState.label)}</span>
            <span class="mono">#${pr.number}</span>
            <span>${escapeHtml(pr.repo)}</span>
          </div>
          <h2 id="drawer-title">${escapeHtml(pr.title)}</h2>
        </div>
        <button type="button" class="btn btn-sm btn-icon btn-ghost" data-close-dialog aria-label="Закрити">${icon('cross', 16)}</button>
      </div>

      <div class="dialog-body">
        <dl class="meta-dl">
          <div><dt>Гілка змін</dt><dd class="mono">${escapeHtml(pr.head)}</dd></div>
          <div><dt>Цільова гілка</dt><dd class="mono">${escapeHtml(pr.base)}</dd></div>
          <div>
            <dt>HEAD SHA</dt>
            <dd>
              <button type="button" class="sha-chip" data-copy="${escapeHtml(pr.sha)}">
                ${escapeHtml(shortSha(pr.sha))} ${icon('copy', 12)}
              </button>
            </dd>
          </div>
          <div><dt>Автор / оновлено</dt><dd>${escapeHtml(pr.author || '—')} · ${escapeHtml(formatDateTime(pr.updatedAt))}</dd></div>
          ${pr.additions != null ? `<div><dt>Обсяг змін</dt><dd>${renderDiffStat(pr)}</dd></div>` : ''}
        </dl>

        <section>
          <h3 style="margin: 0 0 8px; font-size: 14px;">Перевірки GitHub Actions (${(pr.checks || []).length})</h3>
          ${(pr.checks || []).length ? `
            <div class="list-stack">
              ${pr.checks.map((c) => {
                const st = translateCiStatus(c.status, c.conclusion);
                const cUrl = safeUrl(c.url);
                return `
                  <div class="row-card">
                    <div class="row-main">
                      ${cUrl
                        ? `<a href="${escapeHtml(cUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--ink);">${escapeHtml(c.name)}</a>`
                        : `<span>${escapeHtml(c.name)}</span>`}
                      <div class="row-meta"><span>${escapeHtml(formatDateTime(c.updatedAt))}</span></div>
                    </div>
                    <span class="pill pill-${st.tone}">${escapeHtml(st.label)}</span>
                  </div>
                `;
              }).join('')}
            </div>
          ` : '<div class="empty-box">Для поточного HEAD SHA перевірок Actions не зафіксовано.</div>'}
        </section>

        <section>
          <h3 style="margin: 0 0 8px; font-size: 14px;">Пов’язані локальні записи (${related.length})</h3>
          ${related.length ? `
            <div class="list-stack">
              ${related.map((r) => `
                <button type="button" class="search-hit" data-open-record="${escapeHtml(r.id)}">
                  <span>${escapeHtml(r.title)}</span>
                  <span class="pill pill-${statusTone(r.status)}">${escapeHtml(r.status)}</span>
                </button>
              `).join('')}
            </div>
          ` : '<small style="color: var(--subtle);">Ще немає прив’язаних чеклістів або завдань (вкажіть #' + pr.number + ' у полі PR).</small>'}
        </section>
      </div>

      <div class="dialog-foot">
        <button type="button" class="btn btn-sm" data-draft-agent-from-pr="${escapeHtml(pr.repo)}:${pr.number}">
          ${icon('agents', 14)}
          <span>Створити доручення агенту</span>
        </button>
        ${url ? `<a class="btn btn-sm btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Відкрити на GitHub ${icon('outbound', 14)}</a>` : ''}
      </div>
    </div>
  `;
  drawerDialog.showModal();
}

function openRecordDetail(id) {
  const item = state.records.find((r) => r.id === id);
  if (!item) return;
  const kindLabel = WORK_KINDS.find((k) => k.key === item.kind)?.label
    || ({ cycle: 'Поточний цикл', budget: 'Бюджет / ліміт', log: 'Журнал подій' }[item.kind] || 'Запис');

  drawerDialog.innerHTML = `
    <div class="drawer-inner">
      <div class="dialog-head">
        <div>
          <div class="row-meta" style="margin-bottom: 6px;">
            <span class="pill pill-neutral">${escapeHtml(kindLabel)}</span>
            <span class="pill pill-${statusTone(item.status)}">${escapeHtml(item.status)}</span>
          </div>
          <h2 id="drawer-title">${escapeHtml(item.title)}</h2>
        </div>
        <button type="button" class="btn btn-sm btn-icon btn-ghost" data-close-dialog aria-label="Закрити">${icon('cross', 16)}</button>
      </div>

      <div class="dialog-body">
        <dl class="meta-dl">
          <div><dt>Репозиторій</dt><dd>${escapeHtml(item.repo || 'EasyWAR')}</dd></div>
          <div><dt>Відповідальна роль</dt><dd>${escapeHtml(item.role || 'Власник')}</dd></div>
          <div><dt>Оновлено</dt><dd class="num">${escapeHtml(formatDateTime(item.date || item.updatedAt))}</dd></div>
          ${item.prRef ? `<div><dt>Прив’язка PR / гілки</dt><dd class="mono">${escapeHtml(item.prRef)}</dd></div>` : ''}
        </dl>

        ${item.description ? `<p style="margin: 0; white-space: pre-wrap; color: var(--muted);">${escapeHtml(item.description)}</p>` : ''}

        ${item.kind === 'checklist' && Array.isArray(item.items) ? `
          <ul class="check-list">
            ${item.items.map((entry, idx) => `
              <li class="check-item ${entry.done ? 'is-done' : ''}">
                <label>
                  <input type="checkbox" ${entry.done ? 'checked' : ''} data-toggle-check="${escapeHtml(item.id)}:${idx}">
                  <span>${escapeHtml(entry.text)}</span>
                </label>
              </li>
            `).join('')}
          </ul>
        ` : ''}
      </div>

      <div class="dialog-foot">
        <button type="button" class="btn btn-sm btn-danger" data-delete-record="${escapeHtml(item.id)}">
          ${icon('trash', 14)}
          <span>Видалити</span>
        </button>
        <button type="button" class="btn btn-sm btn-primary" data-edit-record="${escapeHtml(item.id)}">
          ${icon('edit', 14)}
          <span>Редагувати</span>
        </button>
      </div>
    </div>
  `;
  drawerDialog.showModal();
}

function openCreateMenu() {
  const options = [
    ...WORK_KINDS,
    { key: 'budget', label: 'Бюджет / ліміт', icon: 'budget' },
    { key: 'log', label: 'Запис у журнал', icon: 'log' },
  ];
  modalDialog.innerHTML = `
    <div class="dialog-head">
      <h2 id="modal-title">Створити новий запис</h2>
      <button type="button" class="btn btn-sm btn-icon btn-ghost" data-close-dialog aria-label="Закрити">${icon('cross', 16)}</button>
    </div>
    <div class="dialog-body">
      <div class="list-stack">
        ${options.map((opt) => `
          <button type="button" class="search-hit" data-create-kind="${opt.key}">
            <span style="display: flex; align-items: center; gap: 10px;">
              ${icon(opt.icon, 18)}
              <strong>${escapeHtml(opt.label)}</strong>
            </span>
            ${icon('chevron', 16)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
  modalDialog.showModal();
}

function openRecordEditor(kind, existingId = null) {
  if (modalDialog.open) modalDialog.close();
  const existing = existingId ? state.records.find((r) => r.id === existingId) : null;
  const k = existing ? existing.kind : kind;
  const statuses = STATUS_BY_KIND[k] || ['У роботі', 'Виконано'];
  const defaultRepo = existing?.repo || (state.repoScope === 'ALL' ? 'EasyWAR' : state.repoScope);
  const checklistLines = existing && Array.isArray(existing.items)
    ? existing.items.map((i) => i.text).join('\n')
    : '';
  const stageLines = existing && Array.isArray(existing.stages)
    ? existing.stages.map((s) => s.label).join('\n')
    : 'Перевірка CI та збірок\nРев’ю відкритих PR\nПриймання релізу';

  drawerDialog.innerHTML = `
    <form id="record-editor-form" class="drawer-inner" data-kind="${escapeHtml(k)}" data-id="${escapeHtml(existing?.id || '')}">
      <div class="dialog-head">
        <h2 id="drawer-title">${existing ? 'Редагування запису' : 'Новий запис'}</h2>
        <button type="button" class="btn btn-sm btn-icon btn-ghost" data-close-dialog aria-label="Закрити">${icon('cross', 16)}</button>
      </div>

      <div class="dialog-body">
        <div class="field">
          <label for="ed-title">Назва</label>
          <input id="ed-title" name="title" class="input" required maxlength="180" value="${escapeHtml(existing?.title || '')}">
        </div>

        <div class="field-row">
          <div class="field">
            <label for="ed-repo">Репозиторій</label>
            <select id="ed-repo" name="repo" class="select">
              ${configuredRepos().map((r) => `<option value="${escapeHtml(r)}" ${defaultRepo === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="ed-status">Статус</label>
            <select id="ed-status" name="status" class="select">
              ${statuses.map((s) => `<option value="${escapeHtml(s)}" ${(existing?.status || statuses[0]) === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="ed-role">Відповідальна роль</label>
            <select id="ed-role" name="role" class="select">
              ${ROLE_OPTIONS.map((r) => `<option value="${escapeHtml(r)}" ${(existing?.role || 'Власник') === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
            </select>
          </div>
          ${k !== 'budget' && k !== 'log' && k !== 'cycle' ? `
            <div class="field">
              <label for="ed-pr">Прив’язка PR / гілки</label>
              <input id="ed-pr" name="prRef" class="input mono" maxlength="64" value="${escapeHtml(existing?.prRef || '')}" placeholder="#248">
            </div>
          ` : ''}
          ${k === 'log' ? `
            <div class="field">
              <label for="ed-date">Дата й час (Київ)</label>
              <input id="ed-date" name="date" type="datetime-local" class="input num" value="${escapeHtml(toKyivInputValue(existing?.date || existing?.updatedAt))}">
            </div>
          ` : ''}
        </div>

        ${k === 'budget' ? `
          <div class="field-row">
            <div class="field">
              <label for="ed-limit">Ліміт</label>
              <input id="ed-limit" name="limit" type="number" step="any" min="0" class="input num" value="${existing?.limit ?? ''}">
            </div>
            <div class="field">
              <label for="ed-used">Використано</label>
              <input id="ed-used" name="used" type="number" step="any" min="0" class="input num" value="${existing?.used ?? ''}">
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="ed-unit">Одиниця</label>
              <input id="ed-unit" name="unit" class="input" maxlength="20" value="${escapeHtml(existing?.unit || 'USD')}">
            </div>
            <div class="field">
              <label for="ed-thresholds">Пороги попередження</label>
              <input id="ed-thresholds" name="thresholds" class="input" maxlength="120" value="${escapeHtml(existing?.thresholds || '')}" placeholder="75% / 100%">
            </div>
          </div>
        ` : ''}

        ${k === 'checklist' ? `
          <div class="field">
            <label for="ed-items">Пункти перевірки (кожен пункт з нового рядка)</label>
            <textarea id="ed-items" name="items" class="textarea" style="min-height: 130px;" placeholder="Пункт 1&#10;Пункт 2">${escapeHtml(checklistLines)}</textarea>
          </div>
        ` : ''}

        ${k === 'cycle' ? `
          <div class="field">
            <label for="ed-stages">3 етапи циклу (кожен із нового рядка)</label>
            <textarea id="ed-stages" name="stages" class="textarea" style="min-height: 90px;">${escapeHtml(stageLines)}</textarea>
          </div>
        ` : ''}

        <div class="field">
          <label for="ed-desc">Опис / контекст</label>
          <textarea id="ed-desc" name="description" class="textarea" maxlength="3000">${escapeHtml(existing?.description || '')}</textarea>
        </div>

        <div id="editor-error" class="form-error" hidden></div>
      </div>

      <div class="dialog-foot">
        ${existing && existing.kind !== 'cycle' ? `
          <button type="button" class="btn btn-sm btn-danger" data-delete-record="${escapeHtml(existing.id)}">
            ${icon('trash', 14)}
            <span>Видалити</span>
          </button>
        ` : '<span></span>'}
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-sm btn-ghost" data-close-dialog>Скасувати</button>
          <button type="submit" class="btn btn-sm btn-primary">
            ${icon('check', 14)}
            <span>Зберегти</span>
          </button>
        </div>
      </div>
    </form>
  `;
  drawerDialog.showModal();
}

function openSearchModal() {
  modalDialog.innerHTML = `
    <div class="dialog-head">
      <h2 id="modal-title">Глобальний пошук</h2>
      <button type="button" class="btn btn-sm btn-icon btn-ghost" data-close-dialog aria-label="Закрити">${icon('cross', 16)}</button>
    </div>
    <div class="dialog-body">
      <input id="global-search-input" class="input" type="search" placeholder="Шукати PR, гілки, коміти, релізи, чеклісти, задачі, доручення…" autocomplete="off">
      <div id="global-search-results" class="search-results">
        <div class="empty-box">Почніть вводити запит, щоб знайти будь-який об’єкт у центрі.</div>
      </div>
    </div>
  `;
  modalDialog.showModal();
  const input = document.getElementById('global-search-input');
  input?.focus();
}

function renderGlobalSearchResults(query) {
  const container = document.getElementById('global-search-results');
  if (!container) return;
  const q = query.trim().toLocaleLowerCase('uk');
  if (!q) {
    container.innerHTML = '<div class="empty-box">Почніть вводити запит, щоб знайти будь-який об’єкт у центрі.</div>';
    return;
  }

  const hits = [];
  for (const pr of state.live.pulls || []) {
    if (`#${pr.number} ${pr.title} ${pr.head} ${pr.sha} ${pr.repo}`.toLocaleLowerCase('uk').includes(q)) {
      hits.push({
        type: 'PR',
        title: `#${pr.number} ${pr.title}`,
        meta: `${pr.repo} · ${shortSha(pr.sha)}`,
        attrs: `data-open-pr="${escapeHtml(pr.repo)}:${pr.number}"`,
      });
    }
  }
  for (const r of state.records) {
    if (`${r.title} ${r.description || ''} ${r.prRef || ''} ${r.repo || ''}`.toLocaleLowerCase('uk').includes(q)) {
      hits.push({
        type: 'Запис',
        title: r.title,
        meta: `${r.repo || 'EasyWAR'} · ${r.status || ''}`,
        attrs: `data-open-record="${escapeHtml(r.id)}"`,
      });
    }
  }
  for (const c of state.live.commits || []) {
    if (`${c.message} ${c.sha} ${c.author} ${c.repo}`.toLocaleLowerCase('uk').includes(q)) {
      hits.push({
        type: 'Коміт',
        title: c.message,
        meta: `${c.repo} · ${shortSha(c.sha)}`,
        attrs: `data-nav-close="code:commits"`,
      });
    }
  }
  for (const rel of state.live.releases || []) {
    if (`${rel.tag} ${rel.name} ${rel.repo}`.toLocaleLowerCase('uk').includes(q)) {
      hits.push({
        type: 'Реліз',
        title: `${rel.tag} ${rel.name && rel.name !== rel.tag ? `— ${rel.name}` : ''}`,
        meta: rel.repo,
        attrs: `data-nav-close="code:releases"`,
      });
    }
  }
  for (const t of state.agentTasks) {
    if (`${t.title} ${t.instruction} ${t.role} ${t.repo}`.toLocaleLowerCase('uk').includes(q)) {
      hits.push({
        type: 'Доручення',
        title: t.title,
        meta: `${t.role} · ${t.repo}`,
        attrs: `data-edit-agent-task="${escapeHtml(t.id)}"`,
      });
    }
  }

  if (!hits.length) {
    container.innerHTML = '<div class="empty-box">За цим запитом нічого не знайдено.</div>';
    return;
  }

  container.innerHTML = hits.slice(0, 25).map((h) => `
    <button type="button" class="search-hit" ${h.attrs}>
      <span style="min-width: 0;">
        <strong style="display: block;">${escapeHtml(h.title)}</strong>
        <small style="color: var(--subtle);">${escapeHtml(h.meta)}</small>
      </span>
      <span class="pill pill-neutral">${escapeHtml(h.type)}</span>
    </button>
  `).join('');
}

function openLightbox(group, index) {
  let list = [];
  if (group === 'live') {
    list = (state.live.screens || []).filter((s) => matchesRepo(s.repo)).map((s) => ({
      title: s.title,
      meta: `${s.platform} · ${shortSha(s.sha)} · ${formatDateTime(s.createdAt)}`,
      src: s.src,
    }));
  } else if (group === 'local') {
    list = (state.localScreens || []).filter((s) => matchesRepo(s.repo)).map((s) => {
      const url = s.blob ? URL.createObjectURL(s.blob) : '';
      if (url) blobUrls.push(url);
      return {
        title: s.title,
        meta: `${s.refLabel || s.repo}${s.sha ? ` · ${shortSha(s.sha)}` : ''} · ${formatDateTime(s.createdAt)}`,
        src: url,
      };
    });
  } else {
    list = BUNDLED_SCREENS.map((s) => ({ title: s.title, meta: s.group, src: s.src }));
  }

  if (!list.length) return;
  state.lightboxList = list;
  state.lightboxIndex = Math.max(0, Math.min(index, list.length - 1));
  renderLightbox();
  if (!lightboxDialog.open) lightboxDialog.showModal();
}

function renderLightbox() {
  const item = state.lightboxList[state.lightboxIndex];
  if (!item) return;
  const total = state.lightboxList.length;
  lightboxDialog.innerHTML = `
    <div class="lightbox-inner">
      <div class="dialog-head">
        <div>
          <h2>${escapeHtml(item.title)}</h2>
          <small style="color: var(--subtle);">${escapeHtml(item.meta)} · ${state.lightboxIndex + 1} / ${total}</small>
        </div>
        <div style="display: flex; gap: 6px;">
          ${total > 1 ? `
            <button type="button" class="btn btn-sm btn-icon" data-lightbox-step="-1" aria-label="Попередній">${icon('chevronLeft', 16)}</button>
            <button type="button" class="btn btn-sm btn-icon" data-lightbox-step="1" aria-label="Наступний">${icon('chevron', 16)}</button>
          ` : ''}
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-close-dialog aria-label="Закрити">${icon('cross', 16)}</button>
        </div>
      </div>
      <div class="lightbox-stage">
        <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.title)}">
      </div>
    </div>
  `;
}

function buildAgentPrompt(task) {
  return [
    `Роль: ${task.role}`,
    `Репозиторій: ${state.live.owner || 'hellwikcoop-arch'}/${task.repo}`,
    task.prRef ? `PR / гілка: ${task.prRef}` : null,
    task.sha ? `Фіксований SHA: ${task.sha}` : null,
    `Завдання: ${task.title}`,
    '',
    'Інструкція:',
    task.instruction,
    '',
    'Обов’язкові обмеження безпеки (AGENTS.md):',
    '- Працювати лише із синтетичними даними; жодних реальних оперативних файлів, токенів чи секретів.',
    '- Українська мова інтерфейсу; local-first, без зовнішніх хмарних передач за замовчуванням.',
    '- Не виконувати злиття в main без окремого підтвердження власника.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/* ===== Event Handling ===== */
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;

  if (target.hasAttribute('data-close-dialog')) {
    const dlg = target.closest('dialog');
    dlg?.close();
    return;
  }

  const repoScope = target.getAttribute('data-repo-scope');
  if (repoScope) {
    state.repoScope = repoScope;
    try {
      localStorage.setItem(STORAGE_REPO_KEY, repoScope);
    } catch {
      // ignore
    }
    render();
    return;
  }

  const action = target.getAttribute('data-action');
  if (action === 'toggle-menu') {
    state.mobileMenuOpen = !state.mobileMenuOpen;
    render();
    return;
  }
  if (action === 'close-menu') {
    state.mobileMenuOpen = false;
    render();
    return;
  }
  if (action === 'refresh-live') {
    await fetchLive({ force: true });
    return;
  }
  if (action === 'open-search') {
    openSearchModal();
    return;
  }
  if (action === 'open-create-menu') {
    openCreateMenu();
    return;
  }
  if (action === 'reset-work-filters') {
    state.workQuery = '';
    state.workStatus = '';
    state.workRole = '';
    render();
    return;
  }
  if (action === 'cancel-agent-edit') {
    state.editingAgentTaskId = null;
    state.agentDraftPrefill = null;
    render();
    return;
  }
  if (action === 'export-backup') {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: '4.0.0',
      records: state.records,
      agentTasks: state.agentTasks,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `easywar-control-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Резервну копію JSON завантажено.');
    return;
  }
  if (action === 'trigger-import') {
    document.getElementById('backup-import-input')?.click();
    return;
  }
  if (action === 'resolve-use-server') {
    const res = await apiFetch('/api/records');
    if (res.ok && Array.isArray(res.data?.records)) {
      state.records = res.data.records;
      state.serverRevision = res.data.revision || 0;
      state.conflictMessage = '';
      state.serverReady = true;
      saveRecordsLocally();
      setPendingSync(false);
      render();
      showToast('Завантажено серверну версію записів.');
    }
    return;
  }
  if (action === 'resolve-use-local') {
    const res = await apiFetch('/api/records');
    if (res.ok && res.data) {
      state.serverRevision = res.data.revision || 0;
      state.conflictMessage = '';
      setPendingSync(true);
      await syncRecordsToServer();
      showToast('Серверні записи оновлено локальною версією.');
    }
    return;
  }

  const navTarget = target.getAttribute('data-nav');
  if (navTarget) {
    navigate(navTarget, {
      codeTab: target.getAttribute('data-code-tab') || undefined,
      codePrFilter: target.getAttribute('data-pr-filter') || undefined,
      workTab: target.getAttribute('data-work-tab') || undefined,
      agentsTab: target.getAttribute('data-agents-tab') || undefined,
    });
    return;
  }

  const navClose = target.getAttribute('data-nav-close');
  if (navClose) {
    if (modalDialog.open) modalDialog.close();
    const [routeId, sub] = navClose.split(':');
    navigate(routeId, routeId === 'code' ? { codeTab: sub } : {});
    return;
  }

  const attentionIdx = target.getAttribute('data-attention-idx');
  if (attentionIdx !== null) {
    const list = buildAttentionItems();
    list[Number(attentionIdx)]?.action();
    return;
  }

  const codeTabSwitch = target.getAttribute('data-code-tab-switch');
  if (codeTabSwitch) {
    state.codeTab = codeTabSwitch;
    render();
    return;
  }

  const workTabSwitch = target.getAttribute('data-work-tab-switch');
  if (workTabSwitch) {
    state.workTab = workTabSwitch;
    render();
    return;
  }

  const agentsTabSwitch = target.getAttribute('data-agents-tab-switch');
  if (agentsTabSwitch) {
    state.agentsTab = agentsTabSwitch;
    render();
    return;
  }

  const copyVal = target.getAttribute('data-copy');
  if (copyVal) {
    copyText(copyVal, `Скопійовано: ${copyVal.slice(0, 12)}`);
    return;
  }

  const prKey = target.getAttribute('data-open-pr');
  if (prKey) {
    if (modalDialog.open) modalDialog.close();
    const [repo, num] = prKey.split(':');
    openPrDetail(repo, num);
    return;
  }

  const draftFromPr = target.getAttribute('data-draft-agent-from-pr');
  if (draftFromPr) {
    const [repo, num] = draftFromPr.split(':');
    const pr = (state.live.pulls || []).find((p) => p.repo === repo && p.number === Number(num));
    if (drawerDialog.open) drawerDialog.close();
    if (pr) {
      state.editingAgentTaskId = null;
      state.agentDraftPrefill = {
        title: `Рев’ю PR #${pr.number}: ${pr.title}`.slice(0, 160),
        role: 'J5',
        repo: pr.repo,
        prRef: `#${pr.number}`,
        sha: pr.sha,
        status: AGENT_STATUSES[0],
        instruction: `Перевірити PR #${pr.number} (${pr.head} → ${pr.base}), верифікувати відповідність AGENTS.md, перевірити тести та описати ризики до злиття.`,
        result: '',
      };
      navigate('agents', { agentsTab: 'tasks' });
    }
    return;
  }

  const recordId = target.getAttribute('data-open-record');
  if (recordId) {
    if (modalDialog.open) modalDialog.close();
    openRecordDetail(recordId);
    return;
  }

  const createKind = target.getAttribute('data-create-kind');
  if (createKind) {
    openRecordEditor(createKind, null);
    return;
  }

  const editRecordId = target.getAttribute('data-edit-record');
  if (editRecordId) {
    openRecordEditor(null, editRecordId);
    return;
  }

  const deleteRecordId = target.getAttribute('data-delete-record');
  if (deleteRecordId) {
    const found = state.records.find((r) => r.id === deleteRecordId);
    if (!found) return;
    if (!confirm(`Видалити запис «${found.title}»?`)) return;
    state.records = state.records.filter((r) => r.id !== deleteRecordId);
    if (drawerDialog.open) drawerDialog.close();
    await persistRecords({
      logTitle: `Видалено запис: ${found.title}`,
      logDesc: 'Запис видалено власником із локального реєстру.',
      logRepo: found.repo || 'EasyWAR',
    });
    showToast('Запис видалено.');
    return;
  }

  const toggleStage = target.getAttribute('data-toggle-stage');
  if (toggleStage) {
    const [cycleId, idxStr] = toggleStage.split(':');
    const cycle = state.records.find((r) => r.id === cycleId);
    const idx = Number(idxStr);
    if (cycle && Array.isArray(cycle.stages) && cycle.stages[idx]) {
      cycle.stages[idx].done = !cycle.stages[idx].done;
      cycle.updatedAt = new Date().toISOString();
      const allDone = cycle.stages.every((s) => s.done);
      cycle.status = allDone ? 'Завершено' : 'Активний';
      await persistRecords({
        logTitle: `Етап циклу: ${cycle.stages[idx].label}`,
        logDesc: cycle.stages[idx].done ? 'Позначено як завершений.' : 'Повернуто у роботу.',
        logRepo: cycle.repo || 'EasyWAR',
      });
    }
    return;
  }

  const lbSpec = target.getAttribute('data-open-lightbox');
  if (lbSpec) {
    const [group, idxStr] = lbSpec.split(':');
    openLightbox(group, Number(idxStr));
    return;
  }

  const lbStep = target.getAttribute('data-lightbox-step');
  if (lbStep) {
    const total = state.lightboxList.length;
    if (total > 1) {
      state.lightboxIndex = (state.lightboxIndex + Number(lbStep) + total) % total;
      renderLightbox();
    }
    return;
  }

  const delScreenId = target.getAttribute('data-delete-screen');
  if (delScreenId) {
    if (!confirm('Видалити цей локальний знімок?')) return;
    await deleteLocalScreenshot(delScreenId);
    await refreshLocalScreens();
    showToast('Локальний знімок видалено.');
    return;
  }

  const copyAgentId = target.getAttribute('data-copy-agent-task');
  if (copyAgentId) {
    const task = state.agentTasks.find((t) => t.id === copyAgentId);
    if (task) copyText(buildAgentPrompt(task), 'Промпт для агента скопійовано.');
    return;
  }

  const editAgentId = target.getAttribute('data-edit-agent-task');
  if (editAgentId) {
    if (modalDialog.open) modalDialog.close();
    state.editingAgentTaskId = editAgentId;
    state.agentDraftPrefill = null;
    navigate('agents', { agentsTab: 'tasks' });
    return;
  }

  const deleteAgentId = target.getAttribute('data-delete-agent-task');
  if (deleteAgentId) {
    const task = state.agentTasks.find((t) => t.id === deleteAgentId);
    if (!task) return;
    if (!confirm(`Видалити доручення «${task.title}»?`)) return;
    const res = await apiFetch(`/api/agent-tasks/${encodeURIComponent(deleteAgentId)}`, { method: 'DELETE' });
    if (res.ok) {
      state.agentTasks = state.agentTasks.filter((t) => t.id !== deleteAgentId);
      if (state.editingAgentTaskId === deleteAgentId) state.editingAgentTaskId = null;
      render();
      showToast('Доручення видалено.');
    } else {
      showToast(res.data?.error || 'Не вдалося видалити доручення.');
    }
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;

  if (target.id === 'backup-import-input' && target.files?.[0]) {
    const file = target.files[0];
    target.value = '';
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.records)) {
        throw new Error('Файл не містить коректного списку records.');
      }
      if (!confirm(`Імпортувати ${parsed.records.length} записів із резервної копії? Поточні локальні записи буде замінено.`)) {
        return;
      }
      state.records = parsed.records;
      await persistRecords({
        logTitle: 'Імпортовано резервну копію JSON',
        logDesc: `Відновлено ${parsed.records.length} записів із файлу ${file.name}.`,
      });
      showToast('Резервну копію успішно імпортовано.');
    } catch (err) {
      showToast(err.message || 'Помилка читання JSON-бекапу.');
    }
    return;
  }

  if (target.id === 'screen-file-input' && target.files?.length) {
    await handleScreenFiles(target.files);
    target.value = '';
    return;
  }

  const bindKey = target.getAttribute('data-bind');
  if (bindKey && target.tagName === 'SELECT') {
    state[bindKey] = target.value;
    render();
    return;
  }

  const toggleCheck = target.getAttribute('data-toggle-check');
  if (toggleCheck) {
    const [recId, idxStr] = toggleCheck.split(':');
    const rec = state.records.find((r) => r.id === recId);
    const idx = Number(idxStr);
    if (!rec || !Array.isArray(rec.items) || !rec.items[idx]) return;
    rec.items[idx].done = Boolean(target.checked);
    const doneCount = rec.items.filter((i) => i.done).length;
    rec.status = doneCount === 0
      ? 'До виконання'
      : (doneCount === rec.items.length ? 'Виконано' : 'У роботі');
    rec.updatedAt = new Date().toISOString();
    await persistRecords({
      logTitle: `Чекліст «${rec.title}»`,
      logDesc: `${rec.items[idx].done ? 'Виконано' : 'Знято позначку'}: ${rec.items[idx].text}`,
      logRepo: rec.repo || 'EasyWAR',
    });
    if (drawerDialog.open) openRecordDetail(rec.id);
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'global-search-input') {
    renderGlobalSearchResults(target.value);
    return;
  }
  const bindKey = target.getAttribute('data-bind');
  if (bindKey && target.tagName === 'INPUT') {
    const cursorPos = target.selectionStart;
    state[bindKey] = target.value;
    render();
    const restored = document.querySelector(`[data-bind="${bindKey}"]`);
    if (restored) {
      restored.focus();
      if (typeof cursorPos === 'number') restored.setSelectionRange(cursorPos, cursorPos);
    }
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;

  if (form.id === 'record-editor-form') {
    event.preventDefault();
    const fd = new FormData(form);
    const kind = form.getAttribute('data-kind');
    const existingId = form.getAttribute('data-id');
    const title = String(fd.get('title') || '').trim();
    const errEl = document.getElementById('editor-error');

    if (!title) {
      if (errEl) {
        errEl.textContent = 'Вкажіть назву запису.';
        errEl.hidden = false;
      }
      return;
    }

    const existing = existingId ? state.records.find((r) => r.id === existingId) : null;
    const nextRecord = {
      ...(existing || {}),
      id: existing?.id || `${kind}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      kind,
      title,
      repo: String(fd.get('repo') || 'EasyWAR'),
      role: String(fd.get('role') || 'Власник'),
      status: String(fd.get('status') || 'У роботі'),
      prRef: String(fd.get('prRef') || '').trim(),
      description: String(fd.get('description') || '').trim(),
      updatedAt: new Date().toISOString(),
    };

    if (kind === 'checklist') {
      const prevMap = new Map((existing?.items || []).map((i) => [i.text.trim(), Boolean(i.done)]));
      const lines = String(fd.get('items') || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const unique = [...new Set(lines)];
      nextRecord.items = unique.map((text, idx) => ({
        id: `ci-${idx}`,
        text,
        done: prevMap.get(text) || false,
      }));
      const done = nextRecord.items.filter((i) => i.done).length;
      nextRecord.status = nextRecord.items.length === 0 || done === 0
        ? 'До виконання'
        : (done === nextRecord.items.length ? 'Виконано' : 'У роботі');
    } else if (kind === 'cycle') {
      const prevDone = new Map((existing?.stages || []).map((s) => [s.label.trim(), Boolean(s.done)]));
      const lines = String(fd.get('stages') || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3);
      nextRecord.stages = (lines.length ? lines : ['Перевірка CI', 'Рев’ю PR', 'Приймання']).map((label) => ({
        label,
        done: prevDone.get(label) || false,
      }));
    } else if (kind === 'budget') {
      const limitRaw = fd.get('limit');
      const usedRaw = fd.get('used');
      nextRecord.limit = limitRaw !== '' ? Number(limitRaw) : null;
      nextRecord.used = usedRaw !== '' ? Number(usedRaw) : null;
      nextRecord.unit = String(fd.get('unit') || 'USD').trim() || 'USD';
      nextRecord.thresholds = String(fd.get('thresholds') || '').trim();
    } else if (kind === 'log') {
      const dateInput = String(fd.get('date') || '').trim();
      nextRecord.date = dateInput ? fromKyivInputValue(dateInput) : new Date().toISOString();
    }

    if (existing) {
      state.records = state.records.map((r) => (r.id === existing.id ? nextRecord : r));
    } else {
      state.records.unshift(nextRecord);
    }

    drawerDialog.close();
    await persistRecords(
      kind !== 'log'
        ? {
            logTitle: `${existing ? 'Оновлено' : 'Створено'}: ${nextRecord.title}`,
            logDesc: `Статус: ${nextRecord.status}`,
            logRepo: nextRecord.repo,
          }
        : {},
    );
    showToast(existing ? 'Зміни збережено.' : 'Запис додано.');
    return;
  }

  if (form.id === 'agent-task-form') {
    event.preventDefault();
    const fd = new FormData(form);
    const errEl = document.getElementById('agent-form-error');
    const payload = {
      title: String(fd.get('title') || '').trim(),
      role: String(fd.get('role') || 'J5'),
      repo: String(fd.get('repo') || 'EasyWAR'),
      prRef: String(fd.get('prRef') || '').trim(),
      sha: String(fd.get('sha') || '').trim(),
      status: String(fd.get('status') || AGENT_STATUSES[0]),
      instruction: String(fd.get('instruction') || '').trim(),
      result: String(fd.get('result') || '').trim(),
    };

    const isEdit = Boolean(state.editingAgentTaskId);
    const url = isEdit
      ? `/api/agent-tasks/${encodeURIComponent(state.editingAgentTaskId)}`
      : '/api/agent-tasks';
    const res = await apiFetch(url, {
      method: isEdit ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      if (errEl) {
        errEl.textContent = res.data?.error || 'Не вдалося зберегти доручення.';
        errEl.hidden = false;
      }
      return;
    }

    if (isEdit) {
      state.agentTasks = state.agentTasks.map((t) => (t.id === res.data.id ? res.data : t));
    } else {
      state.agentTasks.unshift(res.data);
    }
    state.editingAgentTaskId = null;
    state.agentDraftPrefill = null;
    render();
    showToast(isEdit ? 'Доручення оновлено.' : 'Доручення збережено в SQLite.');
  }
});

/* Drag & Drop for local screenshots */
document.addEventListener('dragover', (event) => {
  const zone = event.target.closest?.('#screen-dropzone');
  if (!zone) return;
  event.preventDefault();
  zone.classList.add('is-dragover');
});
document.addEventListener('dragleave', (event) => {
  const zone = event.target.closest?.('#screen-dropzone');
  if (zone) zone.classList.remove('is-dragover');
});
document.addEventListener('drop', async (event) => {
  const zone = event.target.closest?.('#screen-dropzone');
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('is-dragover');
  if (event.dataTransfer?.files?.length) {
    await handleScreenFiles(event.dataTransfer.files);
  }
});

async function handleScreenFiles(files) {
  const refInput = document.getElementById('screen-ref-input');
  const shaInput = document.getElementById('screen-sha-input');
  try {
    const saved = await saveLocalScreenshots({
      repo: state.repoScope === 'ALL' ? 'EasyWAR' : state.repoScope,
      refLabel: refInput?.value || '',
      sha: shaInput?.value || '',
      files,
    });
    if (saved.length) {
      await refreshLocalScreens();
      showToast(`Додано знімків: ${saved.length}`);
    }
  } catch (err) {
    showToast(err.message || 'Не вдалося зберегти знімки.');
  }
}

/* Keyboard shortcuts */
document.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openSearchModal();
    return;
  }
  if (event.key === '/' && !editable && !modalDialog.open && !drawerDialog.open && !lightboxDialog.open) {
    event.preventDefault();
    openSearchModal();
    return;
  }
  if (lightboxDialog.open && state.lightboxList.length > 1) {
    if (event.key === 'ArrowRight') {
      state.lightboxIndex = (state.lightboxIndex + 1) % state.lightboxList.length;
      renderLightbox();
    } else if (event.key === 'ArrowLeft') {
      state.lightboxIndex = (state.lightboxIndex - 1 + state.lightboxList.length) % state.lightboxList.length;
      renderLightbox();
    }
  }
});

/* Close dialogs on backdrop click */
for (const dlg of [drawerDialog, modalDialog, lightboxDialog]) {
  dlg.addEventListener('click', (event) => {
    if (event.target === dlg) dlg.close();
  });
}

window.addEventListener('hashchange', () => {
  parseRoute();
  render();
  document.getElementById('content')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
});

window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_RECORDS_KEY && event.newValue) {
    try {
      const next = JSON.parse(event.newValue);
      if (Array.isArray(next)) {
        state.records = next;
        render();
      }
    } catch {
      // ignore
    }
  }
});

window.addEventListener('beforeunload', revokeBlobUrls);

/* Periodic background sync & live poll */
setInterval(() => {
  if (hasPendingSync() && state.csrfToken && !state.conflictMessage) {
    syncRecordsToServer();
  }
}, 30_000);

setInterval(() => {
  fetchLive({ force: false });
}, 300_000);

/* Boot */
parseRoute();
render();
refreshLocalScreens();
initServer();
