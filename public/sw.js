// O Motor do App PWA (Service Worker)
self.addEventListener('install', (e) => {
    console.log('[Motor PWA] Instalado com sucesso!');
});

self.addEventListener('fetch', (e) => {
    // Apenas deixa a internet fluir normalmente
});