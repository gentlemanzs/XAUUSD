const CACHE_NAME = 'xau-dashboard-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './main.js',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// 1. Khi cài đặt: Tải và lưu các file tĩnh vào Cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Đã cache file tĩnh');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// 2. Khi duyệt web: Bắt các request mạng
self.addEventListener('fetch', (event) => {
  // Nếu là gọi API lấy giá vàng (có chữ /api/gold)
  if (event.request.url.includes('/api/gold') || event.request.url.includes('/api/history')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Lấy được mạng thì nhân bản ra 1 bản lưu vào cache
          const clonedResponse = response.clone();
          caches.open('xau-api-cache').then(cache => cache.put(event.request, clonedResponse));
          return response;
        })
        .catch(() => {
          // Mất mạng -> Lấy dữ liệu API cũ từ cache ra đắp vào
          return caches.match(event.request);
        })
    );
  } else {
    // Nếu là file tĩnh (CSS, JS, HTML) -> Lấy từ Cache luôn cho nhanh (Tải tức thì)
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request);
      })
    );
  }
});