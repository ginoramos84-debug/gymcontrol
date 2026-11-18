const CACHE_NAME = "gymcontrol-cache-v1";

// Lista de ficheiros essenciais que ficam guardados no aparelho para uso offline
const FICHEIROS_OFFLINE = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "https://cdn.tailwindcss.com",
  "https://unpkg.com/dexie/dist/dexie.js"
];

// 1. Instalação: guarda todos os ficheiros na memória do aparelho
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Ficheiros guardados para uso offline!");
      return cache.addAll(FICHEIROS_OFFLINE);
    })
  );
  self.skipWaiting();
});

// 2. Ativação: limpa versões antigas se atualizares o app no futuro
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nomesCache) => {
      return Promise.all(
        nomesCache.map((nome) => {
          if (nome !== CACHE_NAME) {
            return caches.delete(nome);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. Interceção: quando o ginásio abre o app sem internet, entrega da memória local
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((respostaEmCache) => {
      // Se já tem guardado offline, devolve na hora; senão vai à internet
      return respostaEmCache || fetch(event.request);
    })
  );
});