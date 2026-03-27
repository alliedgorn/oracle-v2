# T#358 — PWA Setup for Den Book

**Task**: Make denbook.online installable as a home screen app on iPhone
**Author**: Flint
**Status**: APPROVED (Gorn-approved via Gnarl)

---

## Overview

Add Progressive Web App (PWA) support so Den Book can be installed as a standalone app from iPhone Safari (and other browsers). Uses `vite-plugin-pwa` for manifest generation and service worker.

## Changes

### 1. Install vite-plugin-pwa
- `bun add -D vite-plugin-pwa` in frontend/

### 2. Vite config (vite.config.ts)
- Add VitePWA plugin with:
  - `registerType: 'autoUpdate'` (SW auto-updates)
  - `manifest` block: name, short_name, icons, display: standalone, theme_color, background_color
  - `workbox.runtimeCaching` for basic API/asset caching

### 3. HTML meta tags (index.html)
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
- `<meta name="apple-mobile-web-app-title" content="Den Book">`
- `<link rel="apple-touch-icon" href="/icons/icon-180x180.png">`
- `<meta name="theme-color" content="#1a1a2e">`

### 4. App icons
- Generate PNG icons at: 192x192, 512x512, 180x180 (iOS)
- Use the 🐾 paw emoji rendered to canvas, or a simple SVG-to-PNG
- Place in frontend/public/icons/

### 5. Build verification
- `bun run build` produces manifest.webmanifest and sw.js in dist/
- Serve with Caddy (already configured for denbook.online)

## Out of Scope
- Offline mode (beyond basic asset caching)
- Push notifications
- Background sync

## Testing
- Safari iOS: "Add to Home Screen" shows Den Book icon and opens in standalone mode
- Chrome Android: Install prompt appears
- Desktop Chrome: Install icon in address bar
- Lighthouse PWA audit passes
