# App language settings

The web interface offers English, German, Spanish, French, Italian, Japanese, Korean, Dutch, Polish, Brazilian Portuguese, Russian, Simplified Chinese, and System default. System default follows a supported browser language and uses English when no matching catalog exists. Choose a language in Settings > General. The selection is stored in that browser only and follows the same local-only preference model as the appearance setting.

The translations cover strings in the app's language catalog. A missing catalog entry falls back to English. Many older screens still contain literal English text and are not translated. Dates and numbers continue to use the browser's own formatting locale.

Frontend lint, the Webpack production build, frontend .mjs tests, desktop tests, and the SQLite backend suite passed. The full PostgreSQL suite, live-browser, and packaged-app behavior remain unqualified.
