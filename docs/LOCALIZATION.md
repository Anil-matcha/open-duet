# App language settings

The web interface offers English, Spanish, and System default. System default follows the browser language when a Spanish catalog is available; other browser languages use English. Choose a language in Settings > General. The selection is stored in that browser only and follows the same local-only preference model as the appearance setting.

The first translation covers strings in the app's language catalog. If a Spanish translation is missing, that string falls back to English. Many older screens still contain literal English text and are not translated by this first increment. Dates and numbers continue to use the browser's own formatting locale.

Frontend lint, the Webpack production build, frontend .mjs tests, desktop tests, and the SQLite backend suite passed. PostgreSQL, live-browser, and packaged-app behavior have not been qualified.
