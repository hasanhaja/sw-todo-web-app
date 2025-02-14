const VERSION = "0.0.1";
const STATIC_CACHE_NAME = `static-cache_${VERSION}`;
const DATABASE_NAME = "todo-db";
const STORE_NAME = "todos";
let store;

function defaultGetStore() {
  if (!store) {
    store = createStore(DATABASE_NAME, STORE_NAME);
  }
  return store;
}

// TODO Cache manifest etc, but not service worker. Let the browser handle that.
const assets = [
  "/",
  "/index.html",
  "/main.js",
];

async function cacheStatic() {
  const cache = await caches.open(STATIC_CACHE_NAME);
  await cache.addAll(assets);
  console.log(`${STATIC_CACHE_NAME} has been updated`);
}

async function cleanCache() {
  const keys = await caches.keys();
  return Promise.all(
    keys
      .filter((key) => key !== STATIC_CACHE_NAME)
      .map((key) => caches.delete(key))
  );
}

async function init() {
  await cacheStatic();
  store = createStore(DATABASE_NAME, STORE_NAME);
}

self.addEventListener("install", (e) => {
  console.log(`Version ${VERSION} installed`);
  e.waitUntil(init());
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  console.log(`Version ${VERSION} activated`);
  e.waitUntil(async () => {
    await cleanCache();
    await self.clients.claim(); 
  });
});

// IndexedDB promise wrappers lifted from Jake Archibald's idb-keyval lib: https://github.com/jakearchibald/idb-keyval/blob/main/src/index.ts
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.oncomplete = request.onsuccess = () => resolve(request.result);
    request.onabort = request.onerror = () => reject(request.error);
  });
}

function createStore(dbName, storeName) {
  const request = self.indexedDB.open(dbName);
  request.onupgradeneeded = () => request.result.createObjectStore(storeName);
  const dbPromise = promisifyRequest(request);

  return (transactionMode, fn) =>
    dbPromise.then((db) => 
      fn(db.transaction(storeName, transactionMode).objectStore(storeName))
    );
}

function set(key, value, customStore = defaultGetStore()) {
  return customStore("readwrite", (store) => {
    store.put(value, key);
    return promisifyRequest(store.transaction);
  });
}

function get(key, customStore = defaultGetStore()) {
  return customStore("readonly", (store) => promisifyRequest(store.get(key))); 
}

function update(key, updater, customStore = defaultGetStore()) {
  return customStore("readwrite", (store) => new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        store.put(updater(request.result), key);
        resolve(promisifyRequest(store.transaction));
      } catch (err) {
        reject(err);
      }
    };
  }));
}

function del(key, customStore = defaultGetStore()) {
  return customStore("readwrite", (store) => {
    store.delete(key);
    return promisifyRequest(store.transaction);
  });
}

function entries(customStore = defaultGetStore()) {
  return customStore(
    "readonly", 
    (store) => Promise.all([
      promisifyRequest(store.getAllKeys()),
      promisifyRequest(store.getAll()),
    ]).then(([keys, values]) => keys.map((key, idx) => [key, values[idx]]))
  );
}

/**
  * @typedef {Object} TodoItem
  * @property {string} id
  * @property {string} title
  * @property {boolean} completed
  */

/**
  * @param {string} title
  * @returns {[string, TodoItem]}
  */
function createTodo(title) {
  const id = self.crypto.randomUUID();
  return [
    id,
    { 
      id,
      title,
      completed: false,
    },
  ]
}

/**
  * @param {TodoItem} todo
  * @returns {TodoItem}
  */
function completeTodo(todo) {
  return {
    ...todo,
    completed: true,
  };
}

async function respondWithCache(request) {
  const cacheRes = await caches.match(request); 
  if (cacheRes !== undefined) {
    return cacheRes;
  } 
  // fetch anyways incase the cache is stale
  const fetchRes = await fetch(request);
  const cache = await caches.open(STATIC_CACHE_NAME);
  cache.put(request, fetchRes.clone());
  return fetchRes;
}

async function respondWithSpliced() {
  const res = await caches.match("/");
  const clonedRes = res.clone();
  const originalBody = await clonedRes.text();

  const allEntries= await entries();
  const data = allEntries.map(([, todoItem]) => todoItem);
  const newBody = spliceResponseWithData(originalBody, data);

  return new Response(newBody, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function redirect(path) {
  return Response.redirect(path, 303);
}

function list(id, title, completed) {
  return `
    <li>
      ${ completed ? 
          `<s>${title}</s> <a href="/delete?id=${id}">Delete</a>` 
        : `<a href="/complete?id=${id}">Complete</a> ${title} <a href="/delete?id=${id}">Delete</a>`}
    </li>
  `;
}

/**
  * @param {TodoItem[]} data
  * @returns {string}
  */
function generateTodos(data) {
  return `
    <ul slot="todo-list">
      ${data
          .map(({ id, title, completed }) => list(id, title, completed))
          .join("")
      }
    </ul>
  `;
}

/**
  * @param {string} cachedContent 
  * @param {TodoItem[]} data
  * @returns {string}
  */
function spliceResponseWithData(cachedContent, data) {
  if (!data) {
    return cachedContent;
  }

  const lazyBoundary = "<!-- lazy -->";
  const [head, tail] = cachedContent.split(lazyBoundary);
  return `
    ${head}
    ${generateTodos(data)}
    ${tail}
  `;
}

const ENTITY_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;'
};

/**
  * Taken from Mustache: https://github.com/janl/mustache.js/blob/master/mustache.js#L60C1-L75C2
  * @param {string} unsafe
  * @returns {string}
  */
function escapeHtml(unsafe) {
  return unsafe.replace(/[&<>"'`=\/]/g, s => ENTITY_MAP[s]);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    e.respondWith(respondWithSpliced());
  } else if (path === "/create") {
    e.waitUntil(
      e.request.text()
        .then((text) => new URLSearchParams(text))
        .then(([title, _]) => title)
        .then(([, value]) => escapeHtml(value))
        .then((value) => createTodo(value))
        .then(([ id, value ]) => set(id, value))
    )
    e.respondWith(redirect("/"));
  } else if (path === "/delete") {
    const id = url.searchParams.get("id");
    e.waitUntil(del(id));
    e.respondWith(redirect("/"));
  } else if (path === "/complete") {
    const id = url.searchParams.get("id");
    e.waitUntil(update(id, completeTodo));
    e.respondWith(redirect("/"));
  } else if (assets.includes(path)) {
    e.respondWith(respondWithCache(e.request));
  }
});
