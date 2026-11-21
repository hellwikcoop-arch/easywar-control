const DB_NAME = 'easywar-control-screenshots-v4';
const STORE_NAME = 'screenshots';
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Не вдалося відкрити IndexedDB'));
  });
}

export async function loadLocalScreenshots() {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

async function verifyImageBlob(file) {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error(`Непідтримуваний формат файлу: ${file.name}. Дозволено PNG, JPEG або WebP.`);
  }
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new Error(`Файл ${file.name} перевищує ліміт 15 МБ.`);
  }
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  }
  return { width: 0, height: 0 };
}

export async function saveLocalScreenshots({ repo, refLabel, sha, files }) {
  const list = Array.from(files || []).slice(0, 24);
  if (!list.length) return [];
  const prepared = [];
  for (const file of list) {
    const dims = await verifyImageBlob(file);
    prepared.push({
      id: `loc-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      title: file.name.replace(/\.[^.]+$/, '').slice(0, 100) || 'Знімок екрана',
      repo: repo || 'EasyWAR',
      refLabel: (refLabel || '').trim().slice(0, 80),
      sha: (sha || '').trim().toLowerCase().slice(0, 40),
      width: dims.width,
      height: dims.height,
      size: file.size,
      createdAt: new Date().toISOString(),
      blob: file,
    });
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const item of prepared) store.put(item);
    tx.oncomplete = () => resolve(prepared);
    tx.onerror = () => reject(tx.error || new Error('Помилка збереження знімка'));
  });
}

export async function deleteLocalScreenshot(id) {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
