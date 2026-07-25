/**
 * Service Worker de "La Intersección"
 * ─────────────────────────────────────────────────────────────────────────
 * - Cachea el "shell" de la app (HTML/CSS/JS/iconos) para que cargue offline.
 * - Para los datos de juego (games/, tarde/, escape/*.json): si hay conexión,
 *   siempre trae la versión más reciente; si no hay conexión, usa la última
 *   guardada en caché. Así los jugadores nunca ven un misterio desactualizado
 *   si tienen internet, pero pueden seguir jugando sin conexión.
 * - Cualquier otra petición GET de mismo origen u otro origen (imágenes de
 *   ambientación de las salas de escape room, CDN de Tailwind, fuentes, etc.)
 *   se sirve con "stale-while-revalidate": responde rápido desde caché si
 *   existe, y de fondo actualiza la caché para la próxima vez.
 * - Las peticiones que NO son GET (POST a Apps Script, etc.) nunca se tocan:
 *   se dejan pasar directas a la red, sin interceptar.
 *
 * IMPORTANTE: sube la versión de CACHE_VERSION cada vez que despliegues
 * cambios importantes en index.html/admin.html, para forzar que los
 * navegadores descarten la caché vieja.
 */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `interseccion-static-${CACHE_VERSION}`;
const DATA_CACHE    = `interseccion-data-${CACHE_VERSION}`;
const RUNTIME_CACHE = `interseccion-runtime-${CACHE_VERSION}`;

const ALL_CACHES = [STATIC_CACHE, DATA_CACHE, RUNTIME_CACHE];

// Shell mínimo de la app — ajusta esta lista con tus rutas reales si cambian.
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './favicon-196x196.png',
    './icon-128.png',
];

// Rutas que se consideran "datos de juego" → network-first
function isGameDataRequest(url) {
    return /\/(games|tarde|escape)\/[^/]+\.json(\?.*)?$/.test(url.pathname)
        || /\/(games|tarde|escape)\/index\.json(\?.*)?$/.test(url.pathname);
}

// Extensiones que consideramos "shell estático" de nuestro propio origen → cache-first
function isStaticShellRequest(url) {
    if (url.origin !== self.location.origin) return false;
    return /\.(html?|css|js|png|jpg|jpeg|svg|webp|ico|woff2?|json)$/.test(url.pathname)
        || url.pathname === '/' || url.pathname.endsWith('/');
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {
            // Si algún archivo del shell no existe todavía, no rompas la instalación entera
        }))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names.filter((name) => !ALL_CACHES.includes(name)).map((name) => caches.delete(name))
            )
        ).then(() => self.clients.claim())
    );
});

// Permite que la página fuerce la activación inmediata de una nueva versión
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Solo interceptamos peticiones GET. Todo lo demás (POST a Apps Script, etc.)
    // pasa directo a la red sin tocar.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    if (isGameDataRequest(url)) {
        event.respondWith(_networkFirstThenCache(req, DATA_CACHE));
        return;
    }

    if (isStaticShellRequest(url)) {
        event.respondWith(_cacheFirstThenNetwork(req, STATIC_CACHE));
        return;
    }

    // Todo lo demás (CDN de Tailwind/fuentes, imágenes de ambientación de
    // escape rooms alojadas en otros dominios, etc.): stale-while-revalidate
    event.respondWith(_staleWhileRevalidate(req, RUNTIME_CACHE));
});

async function _networkFirstThenCache(req, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
    } catch (err) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw err;
    }
}

async function _cacheFirstThenNetwork(req, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) {
        // Actualiza en segundo plano para la próxima visita (no bloquea la respuesta)
        fetch(req).then((fresh) => { if (fresh && fresh.ok) cache.put(req, fresh.clone()); }).catch(() => {});
        return cached;
    }
    try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
    } catch (err) {
        // Última red de seguridad: si piden la portada y no hay nada, intenta index.html cacheado
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
        throw err;
    }
}

async function _staleWhileRevalidate(req, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(req);
    const networkPromise = fetch(req).then((fresh) => {
        // Guardamos también respuestas "opacas" (recursos de otro origen sin CORS,
        // como imágenes externas de ambientación de escape rooms) — no podemos
        // inspeccionar su status, pero sí cachearlas para uso offline.
        if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(req, fresh.clone());
        return fresh;
    }).catch(() => null);

    return cached || (await networkPromise) || Response.error();
}
