// App version — simple incremental scheme.
// Bump APP_VERSION on each release: 'v1' -> 'v2' -> 'v3' ...
//
// BUILD_DATE is stamped by Vite at build time (see vite.config.ts), so it can
// never drift from the bundle the user is actually running.

declare const __BUILD_DATE__: string;

export const APP_VERSION = 'v3';

export const BUILD_DATE: string = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '';

/** What the UI shows, e.g. "v3 · 2026-08-28". */
export const APP_VERSION_LABEL = BUILD_DATE ? `${APP_VERSION} · ${BUILD_DATE}` : APP_VERSION;
