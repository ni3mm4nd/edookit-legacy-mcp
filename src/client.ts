import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { load as cheerioLoad } from "cheerio";
import type { BrowserContext } from "playwright";

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

async function getContext(cfg: ClientConfig): Promise<BrowserContext> {
  if (_ctx && _ctxSchool === cfg.school) return _ctx;

  // Close any previous context for a different school
  if (_ctx) {
    try { await _ctx.close(); } catch { /* ignore */ }
    _ctx = null;
  }

  const { chromium } = await import("playwright");
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
    try {
      await testPage.goto(`${baseUrl}/overview/updates`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      // Wait for any OIDC redirects to settle
      await testPage.waitForFunction(
        (lp: string) => !window.location.href.includes(lp),
        "/user/login",
        { timeout: 5_000 }
      ).catch(() => {});
      const finalUrl = testPage.url();
      if (!finalUrl.includes("/user/login")) {
        process.stderr.write("[edookit-portal] Existing session is valid.\n");
        await testPage.close();
        _ctx = ctx;
        _ctxSchool = cfg.school;
        return ctx;
      }
    } catch {
      // ignore, fall through to login
    } finally {
      try { await testPage.close(); } catch { /* ignore */ }
    }
    process.stderr.write("[edookit-portal] Existing session expired, re-logging in...\n");
    // Clear cookies and wipe profile for fresh login
    await ctx.clearCookies();
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return getContext(cfg); // recurse once
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
        const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        const finalUrl = page.url();
        const bodyText = await page.content();
        const status = response?.status() ?? 200;
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(response?.headers() ?? {})) {
          resHeaders[k.toLowerCase()] = v;
        }
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
}
