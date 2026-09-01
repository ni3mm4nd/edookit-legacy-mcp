import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { load as cheerioLoad } from "cheerio";
import type { BrowserContext } from "playwright";
import { chromium } from "playwright";

export interface ClientConfig {
  school: string;
  username?: string;
  password?: string;
}

// ── Persistent browser context (one per process, kept alive) ─────────────────
// The portal (edookit.net) binds PHPSESSID to the TLS client fingerprint.
// Raw Node.js https requests use a different TLS stack and always get 302'd
// back to /user/login even with the correct cookies. All HTTP requests must
// therefore run through the same Playwright browser context that authenticated.

let _ctx: BrowserContext | null = null;
let _ctxSchool: string | null = null;

function profileDir(school: string): string {
  const dir = path.join(os.homedir(), ".cache", "edookit-legacy-mcp", `profile-${school}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ── Plus4U OIDC session storage helpers ──────────────────────────────────────
// After a successful Playwright form-login the Plus4U OIDC SDK keeps the
// session (id_token + refresh_token) in the page's sessionStorage.  We persist
// it to disk so that the next startup can inject it back via addInitScript()
// before the OIDC SDK runs — letting Plus4U do a silent prompt=none re-auth
// instead of showing the credential form again.

const SESSION_STORAGE_FILE = "session-storage.json";

function sessionStoragePath(school: string): string {
  return path.join(profileDir(school), SESSION_STORAGE_FILE);
}

function loadSessionStorage(school: string): Record<string, string> | null {
  const p = sessionStoragePath(school);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    return obj as Record<string, string>;
  } catch {
    return null;
  }
}

async function saveSessionStorage(page: import("playwright").Page, school: string): Promise<void> {
  try {
    const storage = await page.evaluate((): Record<string, string> => {
      const items: Record<string, string> = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key) items[key] = sessionStorage.getItem(key) ?? "";
      }
      return items;
    });
    if (Object.keys(storage).length > 0) {
      fs.writeFileSync(sessionStoragePath(school), JSON.stringify(storage, null, 2), { mode: 0o600 });
      process.stderr.write("[edookit-portal] Saved Plus4U OIDC session storage for fast re-auth.\n");
    }
  } catch {
    // Non-critical — ignore
  }
}

function clearSessionStorage(school: string): void {
  try { fs.rmSync(sessionStoragePath(school), { force: true }); } catch { /* ignore */ }
}

/**
 * Attempt a fast (no-form) login by injecting saved Plus4U OIDC session
 * storage into the page before it loads, then letting the SDK do a silent
 * prompt=none callback.  Returns true if edookit auth cookies appeared.
 */
async function tryFastLogin(
  ctx: BrowserContext,
  cfg: ClientConfig,
  savedStorage: Record<string, string>,
): Promise<boolean> {
  const baseUrl = `https://${cfg.school}.edookit.net`;
  const page = await ctx.newPage();
  try {
    // Inject saved sessionStorage before any page JS runs (addInitScript fires
    // in the page context before the first script tag executes).
    await page.addInitScript((storage: Record<string, string>) => {
      try {
        Object.entries(storage).forEach(([k, v]) => sessionStorage.setItem(k, v));
      } catch { /* sandboxed context */ }
    }, savedStorage);

    // Do NOT strip prompt=none this time — we WANT the silent re-auth to work.
    await page.goto(`${baseUrl}/user/login`, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    }).catch(() => {});

    // Wait up to 20 s for auth cookies (prompt=none is fast when it works)
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const cookies = await ctx.cookies(baseUrl);
      if (cookies.some((c) => c.name === "X-EdooAuthToken" || c.name === "X-Auth-Id")) {
        // Confirm session by navigating to a real page
        try {
          await page.goto(`${baseUrl}/overview/updates`, {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
          await page.waitForFunction(
            (lp: string) => !window.location.href.includes(lp),
            "/user/login",
            { timeout: 6_000 }
          ).catch(() => {});
        } catch { /* best-effort */ }
        process.stderr.write("[edookit-portal] Fast re-auth succeeded (Plus4U prompt=none).\n");
        // Refresh the saved session storage after a successful fast re-auth
        await saveSessionStorage(page, cfg.school);
        return true;
      }
      await page.waitForTimeout(300);
    }
    return false;
  } catch {
    return false;
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

async function getContext(cfg: ClientConfig): Promise<BrowserContext> {
  if (_ctx && _ctxSchool === cfg.school) return _ctx;

  // Close any previous context for a different school
  if (_ctx) {
    try { await _ctx.close(); } catch { /* ignore */ }
    _ctx = null;
  }

  const dir = profileDir(cfg.school);
  const headless = !!(cfg.username && cfg.password);

  process.stderr.write("[edookit-portal] Launching persistent browser context...\n");
  const ctx = await chromium.launchPersistentContext(dir, {
    headless,
    args: ["--no-sandbox"],
  });

  const baseUrl = `https://${cfg.school}.edookit.net`;

  // Check if we already have a valid session in the profile
  const existingCookies = await ctx.cookies(baseUrl);
  const hasSession = existingCookies.some((c) => c.name === "X-EdooAuthToken" || c.name === "PHPSESSID");

  if (hasSession) {
    // Verify the session is actually usable
    process.stderr.write("[edookit-portal] Found existing cookies, verifying session...\n");
    const testPage = await ctx.newPage();
    let sessionValid = false;
    try {
      // Navigate to login page — valid session redirects away, expired session stays
      await testPage.goto(`${baseUrl}/user/login`, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      }).catch(() => {});
      const finalUrl = testPage.url();
      // If redirected away from /user/login — session is valid
      sessionValid = !finalUrl.includes("/user/login");
    } catch {
      // ignore, treat as expired
    } finally {
      try { await testPage.close(); } catch { /* ignore */ }
    }

    if (sessionValid) {
      process.stderr.write("[edookit-portal] Existing session is valid.\n");
      _ctx = ctx;
      _ctxSchool = cfg.school;
      return ctx;
    }

    process.stderr.write("[edookit-portal] Existing session expired, attempting Plus4U fast re-auth...\n");

    // Try headless re-auth by injecting saved Plus4U OIDC session storage.
    // This avoids spawning a new context or wiping the profile — just clears
    // the stale edookit cookies and lets the OIDC SDK renew them.
    const savedStorage = loadSessionStorage(cfg.school);
    if (savedStorage && cfg.username && cfg.password) {
      await ctx.clearCookies();
      const fastOk = await tryFastLogin(ctx, cfg, savedStorage);
      if (fastOk) {
        _ctx = ctx;
        _ctxSchool = cfg.school;
        return ctx;
      }
      process.stderr.write("[edookit-portal] Fast re-auth failed, falling back to form login...\n");
      clearSessionStorage(cfg.school);
    }

    // Fast path failed (or no saved storage) — wipe profile and do a full form login
    await ctx.clearCookies();
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Create a fresh context and log in directly (no verification check on brand-new session)
    const freshCtx = await chromium.launchPersistentContext(dir, { headless, args: ["--no-sandbox"] });
    await loginWithContext(freshCtx, cfg);
    _ctx = freshCtx;
    _ctxSchool = cfg.school;
    return freshCtx;
  }

  // No existing session — log in
  await loginWithContext(ctx, cfg);

  _ctx = ctx;
  _ctxSchool = cfg.school;
  return ctx;
}

async function loginWithContext(ctx: BrowserContext, cfg: ClientConfig): Promise<void> {
  const baseUrl = `https://${cfg.school}.edookit.net`;
  const headless = !!(cfg.username && cfg.password);

  if (headless) {
    process.stderr.write("[edookit-portal] Logging in with username/password...\n");
  } else {
    process.stderr.write(
      "[edookit-portal] No credentials provided. Opening browser for interactive login.\n" +
      "[edookit-portal] Please log in in the browser window that opens.\n"
    );
  }

  const page = await ctx.newPage();

  // Strip prompt=none so Plus4U doesn't silently skip the credential form
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.includes("prompt=none") && url.includes("93b2c166a7aa436baa0278b8f5c736db")) {
      route.continue({ url: url.replace("&prompt=none", "").replace("prompt=none&", "") });
    } else {
      route.continue();
    }
  });

  try {
    await page.goto(`${baseUrl}/user/login`);

    if (cfg.username && cfg.password) {
      // Wait for either the login form OR auth cookies (silent SSO may skip the form)
      await Promise.race([
        page.waitForSelector('input[name="username"]', { timeout: 20_000 }),
        (async () => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const cookies = await ctx.cookies(baseUrl);
            if (cookies.some((c) => c.name === "X-EdooAuthToken" || c.name === "X-Auth-Id")) return;
            await page.waitForTimeout(200);
          }
        })(),
      ]);

      // Check if already authenticated via silent SSO
      const earlyCheck = await ctx.cookies(baseUrl);
      if (!earlyCheck.some((c) => c.name === "X-EdooAuthToken" || c.name === "X-Auth-Id")) {
        // Form is visible — fill credentials
        await page.fill('input[name="username"]', cfg.username);
        await page.locator("button.uuelements-1gc3md2").first().click({ force: true });
        await page.waitForSelector('input[name="password"]', { timeout: 15_000 });
        await page.fill('input[name="password"]', cfg.password);
        await page.evaluate(() => {
          const s = document.querySelector<HTMLInputElement>('input[type="submit"]');
          if (s) s.click();
        });
        process.stderr.write("[edookit-portal] Credentials submitted, waiting for session...\n");
      } else {
        process.stderr.write("[edookit-portal] Silent SSO detected — forcing credential form...\n");
        // Silent SSO happened but we need a fresh credential-bound session.
        // Navigate to logout to kill the SSO session, then retry login.
        try { await page.goto(`${baseUrl}/user/logout`, { timeout: 10_000 }); } catch { /* ignore */ }
        await page.goto(`${baseUrl}/user/login`);
        await page.waitForSelector('input[name="username"]', { timeout: 20_000 });
        await page.fill('input[name="username"]', cfg.username);
        await page.locator("button.uuelements-1gc3md2").first().click({ force: true });
        await page.waitForSelector('input[name="password"]', { timeout: 15_000 });
        await page.fill('input[name="password"]', cfg.password);
        await page.evaluate(() => {
          const s = document.querySelector<HTMLInputElement>('input[type="submit"]');
          if (s) s.click();
        });
        process.stderr.write("[edookit-portal] Credentials submitted after SSO bypass, waiting...\n");
      }
    }

    // Wait for auth cookies
    const timeout = headless ? 30_000 : 5 * 60_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const cookies = await ctx.cookies(baseUrl);
      if (cookies.some((c) => c.name === "X-EdooAuthToken" || c.name === "X-Auth-Id")) {
        // Navigate to confirm the full OIDC callback and get a bound PHPSESSID
        process.stderr.write("[edookit-portal] Auth cookies found, confirming session...\n");
        try {
          await page.goto(`${baseUrl}/overview/updates`, { waitUntil: "domcontentloaded", timeout: 15_000 });
          // Wait for OIDC redirects to fully settle
          await page.waitForFunction(
            (loginPath: string) => !window.location.href.includes(loginPath),
            "/user/login",
            { timeout: 8_000 }
          ).catch(() => { /* best-effort — if still on login, portalFetch will re-auth */ });
        } catch {
          // best-effort
        }
        process.stderr.write("[edookit-portal] Authentication successful.\n");
        await saveSessionStorage(page, cfg.school);
        await page.close();
        return;
      }
      await page.waitForTimeout(300);
    }

    throw new Error(
      headless
        ? "Login timed out. Check EDOOKIT_USERNAME and EDOOKIT_PASSWORD."
        : "Interactive login timed out after 5 minutes."
    );
  } catch (err) {
    try { await page.close(); } catch { /* ignore */ }
    throw err;
  }
}

// ── HTTP client (via Playwright browser context) ──────────────────────────────

/**
 * Send an AJAX request from within the authenticated browser page.
 * Automatically reads the uu.app.csrf cookie and sends it as X-CSRF-Token.
 * Returns the response body as a string.
 */
export async function portalAjax(
  cfg: ClientConfig,
  urlPath: string,
): Promise<string> {
  const ctx = await getContext(cfg);
  const baseUrl = `https://${cfg.school}.edookit.net`;
  const url = `${baseUrl}${urlPath}`;

  const page = await ctx.newPage();
  try {
    // Load a neutral page first so we're on the same origin (needed for credentials: "include")
    await page.goto(`${baseUrl}/timetable/`, { waitUntil: "networkidle", timeout: 25_000 });
    const cookies = await ctx.cookies(baseUrl);
    const csrf = cookies.find((c) => c.name === "uu.app.csrf")?.value ?? "";

    const body = await page.evaluate(
      async ({ reqUrl, csrfToken }) => {
        const r = await fetch(reqUrl, {
          method: "GET",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": csrfToken,
            "Accept": "*/*",
          },
          credentials: "include",
        });
        return r.text();
      },
      { reqUrl: url, csrfToken: csrf }
    );
    return body;
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

export async function portalFetch(
  cfg: ClientConfig,
  urlPath: string,
  options: {
    method?: string;
    body?: string | URLSearchParams;
    extraHeaders?: Record<string, string>;
    followRedirects?: boolean;
  } = {}
): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }> {
  const ctx = await getContext(cfg);
  const baseUrl = `https://${cfg.school}.edookit.net`;
  const url = `${baseUrl}${urlPath}`;

  const { method = "GET", body, extraHeaders = {} } = options;

  let bodyStr: string | undefined;
  let contentType: string | undefined;
  if (body instanceof URLSearchParams) {
    bodyStr = body.toString();
    contentType = "application/x-www-form-urlencoded";
  } else if (typeof body === "string") {
    bodyStr = body;
    contentType = "application/json";
  }

  const makeRequest = (context: BrowserContext) =>
    async (targetUrl: string): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }> => {
      // ctx.request is an isolated APIRequestContext that doesn't share cookies
      // with the browser's own cookie jar. Use a page navigation instead so the
      // same cookie store that authenticated is used for all requests.
      const page = await context.newPage();
      try {
        if (method !== "GET" && method !== "get" && bodyStr) {
          // POST: use page.evaluate to submit a fetch from within the browser
          await page.goto("about:blank");
          const result = await page.evaluate(
            async ({ url, method: m, body: b, headers: h }) => {
              const resp = await fetch(url, {
                method: m,
                headers: h,
                body: b,
                redirect: "follow",
                credentials: "include",
              });
              return {
                status: resp.status,
                finalUrl: resp.url,
                body: await resp.text(),
              };
            },
            { url: targetUrl, method, body: bodyStr, headers: { "Accept": "text/html,application/xhtml+xml,*/*", "Accept-Language": "cs,en;q=0.9", ...(contentType ? { "Content-Type": contentType } : {}), ...extraHeaders } }
          );
          return { status: result.status, headers: {}, body: result.body, finalUrl: result.finalUrl };
        }

        // GET: standard page navigation
        await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 25_000 });
        // Wait for any OIDC redirects to fully settle before reading finalUrl
        await page.waitForFunction(
          (lp: string) => !window.location.href.includes(lp),
          "/user/login",
          { timeout: 8_000 }
        ).catch(() => { /* best-effort — caller checks finalUrl */ });
        const finalUrl = page.url();
        const bodyText = await page.content();
        const response = null; // networkidle path doesn't expose response easily
        const status = finalUrl.includes("/user/login") ? 302 : 200;
        const resHeaders: Record<string, string> = {};
        return { status, headers: resHeaders, body: bodyText, finalUrl };
      } finally {
        try { await page.close(); } catch { /* ignore */ }
      }
    };

  let result = await makeRequest(ctx)(url);

  if (result.finalUrl.includes("/user/login")) {
    process.stderr.write("[edookit-portal] Session expired, re-authenticating...\n");
    // Wipe context and re-login
    try { await _ctx?.close(); } catch { /* ignore */ }
    _ctx = null;
    _ctxSchool = null;
    fs.rmSync(profileDir(cfg.school), { recursive: true, force: true });

    const freshCtx = await getContext(cfg);
    const freshResult = await makeRequest(freshCtx)(url);
    if (freshResult.finalUrl.includes("/user/login")) {
      throw new Error("Authentication failed. Check EDOOKIT_USERNAME and EDOOKIT_PASSWORD.");
    }
    return freshResult;
  }

  return result;
}

// Keep raw https for cases where Playwright context isn't available (unused internally now)
export { };

export function parseHtml(html: string) {
  return cheerioLoad(html);
}

export function extractToken(html: string, formSelector = "form"): string {
  const $ = parseHtml(html);
  return ($(formSelector).find('input[name="_token"]').val() as string) ?? "";
}

// Legacy exports kept for any callers
export async function getSessionCookies(cfg: ClientConfig): Promise<Array<{ name: string; value: string }>> {
  const ctx = await getContext(cfg);
  const baseUrl = `https://${cfg.school}.edookit.net`;
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => ({ name: c.name, value: c.value }));
}

export function invalidateSession(school: string) {
  if (_ctxSchool === school) {
    _ctx?.close().catch(() => { /* ignore */ });
    _ctx = null;
    _ctxSchool = null;
  }
  const dir = path.join(os.homedir(), ".cache", "edookit-legacy-mcp", `profile-${school}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  clearSessionStorage(school);
}
