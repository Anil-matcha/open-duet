# App language settings

The web interface offers English, German, Spanish, French, Italian, Japanese, Korean, Dutch, Polish, Brazilian Portuguese, Russian, Turkish, and Simplified Chinese. English is the default. The language picker is visible on sign-in and workspace recovery, in the chat header, and in Settings > General; choosing a language saves it in this browser and applies immediately. An older saved “system” choice is treated as English. Dates and numbers continue to use the browser's own formatting locale.

The shared catalog covers sign-in and setup, chat and composer, sidebar, conversation search, common planner controls, approval cards and saved-rule controls, and team and room actions. The decision-log summaries, health-scan details, other specialized settings and agent screens, and text supplied by engines, agents, or the backend can still contain English. Missing catalog entries fall back to English.

Frontend lint, the Webpack production build, frontend .mjs tests, desktop tests, and the SQLite backend suite passed for earlier localization changes. This update has not been qualified on a live browser or packaged app. The full PostgreSQL suite remains unqualified.
