export const STATIC: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/i18n.js': 'i18n.js', '/style.css': 'style.css',
  '/chrome.js': 'chrome.js', '/chrome.css': 'chrome.css', '/done-ticker.js': 'done-ticker.js',
  '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg',
  '/asks': 'asks.html', '/asks.js': 'asks.js', '/user-ask.js': 'user-ask.js', '/asks.css': 'asks.css',
  '/theme-boot.js': 'theme-boot.js',
  '/fleet': 'fleet.html', '/fleet.js': 'fleet.js', '/fleet.css': 'fleet.css',
};
export const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  webmanifest: 'application/manifest+json', svg: 'image/svg+xml', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
};
/** The bundled design system (public/ds/): plain names only, no subfolders but fonts/. */
export const DS_FILE_RE = /^\/ds\/((?:fonts\/)?[A-Za-z0-9][A-Za-z0-9.-]*\.(?:css|woff2|txt))$/;
