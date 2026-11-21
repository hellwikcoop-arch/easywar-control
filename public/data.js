export const DEFAULT_REPOS = ['EasyWAR', 'easywar-staff', 'easywar-releases'];

export const ROLE_OPTIONS = ['Власник', 'J5', 'J3', 'J4', 'C5.1', 'Усі'];

export const WORK_KINDS = [
  { key: 'checklist', label: 'Чекліст приймання', plural: 'Чеклісти', icon: 'work' },
  { key: 'task', label: 'Завдання', plural: 'Завдання', icon: 'agents' },
  { key: 'decision', label: 'Рішення', plural: 'Рішення', icon: 'decision' },
  { key: 'question', label: 'Відкрите питання', plural: 'Питання', icon: 'question' },
  { key: 'next', label: 'Наступний крок', plural: 'Наступні кроки', icon: 'next' },
];

export const STATUS_BY_KIND = {
  cycle: ['Активний', 'На перевірці', 'Завершено'],
  checklist: ['До виконання', 'У роботі', 'Виконано'],
  task: ['У черзі', 'У роботі', 'На перевірці', 'Виконано', 'Заблоковано'],
  decision: ['На погодженні', 'Погоджено', 'Відкладено'],
  question: ['Потрібна відповідь', 'У роботі', 'Закрито'],
  next: ['Заплановано', 'У роботі', 'Виконано'],
  budget: ['У межах ліміту', 'Потрібна увага', 'Перевищено'],
  log: ['Зафіксовано', 'Оновлено', 'Увага'],
};

export const AGENT_ROLES = ['J5', 'J3', 'J4', 'C5.1', 'Власник'];

export const AGENT_STATUSES = [
  'Чернетка · очікує передачі агенту',
  'Передано вручну',
  'На перевірці',
  'Виконано',
  'Заблоковано',
];

export const BUNDLED_SCREENS = [
  { id: 'scr-01', title: 'Стартовий екран EasyWAR', group: 'Основний інтерфейс', src: './screens/01-start.jpg' },
  { id: 'scr-02', title: 'Повітряні сили · панель', group: 'ПС', src: './screens/02-ps-dashboard.jpg' },
  { id: 'scr-06', title: 'Ракетні війська · огляд', group: 'РВ', src: './screens/06-rv-dashboard.jpg' },
  { id: 'scr-07', title: 'Власний модуль', group: 'Модулі', src: './screens/07-custom.jpg' },
  { id: 'scr-08', title: 'Артилерія · панель', group: 'Артилерія', src: './screens/08-artillery.jpg' },
  { id: 'scr-09', title: 'Армійська авіація', group: 'АА', src: './screens/09-army-aviation.jpg' },
  { id: 'scr-10', title: 'ПВК · робоча панель', group: 'ПВК', src: './screens/10-pvk-panel.jpg' },
  { id: 'scr-11', title: 'ПВК · дашборд огляду', group: 'ПВК', src: './screens/11-pvk-dashboard.jpg' },
  { id: 'scr-12', title: 'ДШВ · вибір модуля', group: 'ДШВ', src: './screens/12-dshv-dashboard.jpg' },
];

export function createSeedRecords() {
  const now = new Date().toISOString();
  return [
    {
      id: 'cycle-current',
      kind: 'cycle',
      title: 'Поточний цикл контролю EasyWAR',
      repo: 'EasyWAR',
      role: 'Власник',
      status: 'Активний',
      description: 'Перевірка відкритих PR, стабільності збірок Desktop build та готовності чергового релізу без витоку оперативних даних.',
      stages: [
        { label: 'Перевірка CI та збірок', done: true },
        { label: 'Рев’ю відкритих PR', done: false },
        { label: 'Приймання релізу', done: false },
      ],
      updatedAt: now,
    },
    {
      id: 'chk-release-gate',
      kind: 'checklist',
      title: 'Чекліст приймання перед релізом EasyWAR',
      repo: 'EasyWAR',
      role: 'Власник',
      status: 'У роботі',
      description: 'Базова перевірка перед злиттям змін у main та випуском нової версії.',
      items: [
        { id: 'i1', text: 'Усі перевірки Desktop build у GitHub Actions завершилися успішно', done: true },
        { id: 'i2', text: 'Інтерфейс перевірено українською мовою, без зайвих мережевих запитів', done: true },
        { id: 'i3', text: 'Відкриті чернетки PR переглянуто або відкладено на наступний цикл', done: false },
        { id: 'i4', text: 'Скріншоти оновлених модулів збережено у розділі «Екрани й збірки»', done: false },
        { id: 'i5', text: 'Резервну копію локальної бази центру створено перед релізом', done: false },
      ],
      prRef: '',
      updatedAt: now,
    },
    {
      id: 'q-drafts-triage',
      kind: 'question',
      title: 'Чи включати відкриті чернетки PR у найближчий реліз?',
      repo: 'EasyWAR',
      role: 'J3',
      status: 'Потрібна відповідь',
      description: 'Потрібно визначити, які draft PR готові до фінального рев’ю, а які залишаються на наступний цикл.',
      prRef: '',
      updatedAt: now,
    },
    {
      id: 'dec-local-first',
      kind: 'decision',
      title: 'Контроль GitHub працює виключно в режимі читання',
      repo: 'EasyWAR',
      role: 'Власник',
      status: 'Погоджено',
      description: 'Локальний центр не змінює репозиторії, не зливає PR і не надсилає оперативні дані в хмару.',
      prRef: '',
      updatedAt: now,
    },
    {
      id: 'next-verify-build',
      kind: 'next',
      title: 'Перевірити останню збірку Desktop build і звірити релізні файли',
      repo: 'EasyWAR',
      role: 'Власник',
      status: 'У роботі',
      description: 'Відкрити вкладку «Код і релізи → Збірки CI» та переконатися, що збірка для macOS і Windows зелена.',
      prRef: '',
      updatedAt: now,
    },
    {
      id: 'budget-ai-monthly',
      kind: 'budget',
      title: 'Місячний ліміт допоміжних AI-викликів',
      repo: 'easywar-staff',
      role: 'Власник',
      status: 'У межах ліміту',
      limit: 50,
      used: 12,
      unit: 'USD',
      thresholds: 'Попередження: 75% · Зупинка: 100%',
      description: 'Ручний контроль витрат на зовнішні запити координації за правилами AGENTS.md.',
      updatedAt: now,
    },
    {
      id: 'log-init',
      kind: 'log',
      title: 'Ініціалізовано Центр контролю EasyWAR v4',
      repo: 'EasyWAR',
      role: 'Власник',
      status: 'Зафіксовано',
      description: 'Створено стартову конфігурацію для контролю репозиторію в режимі читання.',
      date: now,
      updatedAt: now,
    },
  ];
}
