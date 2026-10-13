import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: "Dave's World",
        short_name: "Dave's World",
        description: "Dave's personal collection of tools: recipes, recommendations, weather, movies, trail posters, and more.",
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#faf8f5',
        theme_color: '#c0622f',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/recipes.json', '**/embedWorker-*.js'],
        // The app ships as one unsplit bundle (no route-level code splitting
        // yet), so it exceeds Workbox's default 2 MiB precache cap.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) ||
              url.hostname === 'tiles.openfreemap.org' ||
              url.hostname === 'api.maptiler.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) =>
              url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'unpkg.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'unpkg-assets',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/recipes.json',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'recipes-data' },
          },
        ],
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
  },
})
