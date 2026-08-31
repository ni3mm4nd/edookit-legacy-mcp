import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { load as cheerioLoad } from "cheerio";

export interface ClientConfig {
  school: string;
  username?: string;
  password?: string;
}

interface CachedSession {
  timestamp: number;
  baseUrl: string;
  cookies: Array<{ name: string; value: string }>;
}

const SESSION_MAX_AGE_MS = 10 * 60 * 60 * 1000; // 10 hours

function cacheFilePath(school: string): string {
  const dir = path.join(os.homedir(), ".cache", "edookit-legacy-mcp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${school}.session.json`);
}

function loadCachedSession(school: string): CachedSession | null {
  const p = cacheFilePath(school);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data: CachedSession = JSON.parse(raw);
    const age = Date.now() - data.timestamp;
    if (age > SESSION_MAX_AGE_MS) return null;
    if (!data.cookies?.length) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCachedSession(school: string, cookies: Array<{ name: string; value: string }>) {
  const p = cacheFilePath(school);
  const data: CachedSession = {
    timestamp: Date.now(),
    baseUrl: `https://${school}.edookit.net`,
    cookies,
  };
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, p);
  fs.chmodSync(p, 0o600);
}

/** Log in via Plus4U two-step form (email → password) or interactively if no credentials given. */
async function loginViaBrowser(cfg: ClientConfig): Promise<Array<{ name: string; value: string }>> {
  const { chromium } = await import("playwright");

  const profileDir = path.join(os.homedir(), ".cache", "edookit-legacy-mcp", `profile-${cfg.school}`);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

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

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    args: ["--no-sandbox"],
  });

  try {
    const page = await ctx.newPage();

    // Strip prompt=none so Plus4U doesn't silently fail when no active session
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.includes("prompt=none") && url.includes("93b2c166a7aa436baa0278b8f5c736db")) {
        route.continue({ url: url.replace("&prompt=none", "").replace("prompt=none&", "") });
      } else {
        route.continue();
      }
    });

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
        await page.locator('button.uuelements-1gc3md2').first().click({ force: true });
        await page.waitForSelector('input[name="password"]', { timeout: 15_000 });
        await page.fill('input[name="password"]', cfg.password);
        await page.evaluate(() => {
          const s = document.querySelector<HTMLInputElement>('input[type="submit"]');
          if (s) s.click();
        });
        process.stderr.write("[edookit-portal] Credentials submitted, waiting for session...\n");
      } else {
        process.stderr.write("[edookit-portal] Silent SSO succeeded\n");
      }
    }

    // Wait for auth cookies (up to 5 min for interactive, 30s for headless)
    const timeout = headless ? 30_000 : 5 * 60_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const cookies = await ctx.cookies(baseUrl);
      if (cookies.some((c) => c.name === "X-EdooAuthToken" || c.name === "X-Auth-Id")) {
        // Navigate to a real portal page so the server completes the OIDC
        // callback and sets the final PHPSESSID bound to this session.
        // Without this, the PHPSESSID we extract is from before /oidc/callback
        // and the raw https client gets 302'd back to /user/login.
        process.stderr.write("[edookit-portal] Auth cookies found, confirming session via portal...\n");
        try {
          await page.goto(`${baseUrl}/overview/updates`, { waitUntil: "domcontentloaded", timeout: 15_000 });
        } catch {
          // best-effort — if navigation fails we still proceed with whatever cookies we have
        }
        const finalCookies = await ctx.cookies(baseUrl);
        const relevant = finalCookies
          .filter((c) =>
            ["PHPSESSID", "X-Auth-Id", "X-EdooAuthToken", "X-EdooCacheId", "uu.app.csrf"].includes(c.name)
          )
          .map((c) => ({ name: c.name, value: c.value }));
        process.stderr.write("[edookit-portal] Authentication successful\n");
        return relevant;
      }
      await page.waitForTimeout(300);
    }

    throw new Error(
      headless
        ? "Login timed out. Check EDOOKIT_USERNAME and EDOOKIT_PASSWORD."
        : "Interactive login timed out after 5 minutes."
    );
  } finally {
    await ctx.close();
  }
}

// ── Session cache ──────────────────────────────────────────────────────────

let _sessionCookies: Array<{ name: string; value: string }> | null = null;

export async function getSessionCookies(cfg: ClientConfig): Promise<Array<{ name: string; value: string }>> {
  if (_sessionCookies) return _sessionCookies;

  const cached = loadCachedSession(cfg.school);
  if (cached) {
    process.stderr.write("[edookit-portal] Using cached session\n");
    _sessionCookies = cached.cookies;
    return _sessionCookies;
  }

  const cookies = await loginViaBrowser(cfg);
  saveCachedSession(cfg.school, cookies);
  _sessionCookies = cookies;
  process.stderr.write(`[edookit-portal] Session obtained, got ${cookies.length} cookies\n`);
  return _sessionCookies;
}

export function invalidateSession(school: string) {
  _sessionCookies = null;
  try { fs.unlinkSync(cacheFilePath(school)); } catch {}
}

// ── HTTP client ────────────────────────────────────────────────────────────

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
  const cookies = await getSessionCookies(cfg);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const { method = "GET", body, extraHeaders = {}, followRedirects = true } = options;
  const url = `https://${cfg.school}.edookit.net${urlPath}`;

  const result = await rawFetch(url, cookieHeader, method, body, extraHeaders, followRedirects);

  // If redirected to login, invalidate session and retry once with fresh login
  if (result.finalUrl.includes("/user/login") || result.finalUrl.includes("user/oidc")) {
    process.stderr.write("[edookit-portal] Session invalid, re-authenticating...\n");
    invalidateSession(cfg.school);
    const freshCookies = await getSessionCookies(cfg);
    const freshHeader = freshCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const retry = await rawFetch(url, freshHeader, method, body, extraHeaders, followRedirects);
    if (retry.finalUrl.includes("/user/login")) {
      throw new Error("Authentication failed. Check EDOOKIT_USERNAME and EDOOKIT_PASSWORD.");
    }
    return retry;
  }

  return result;
}

function rawFetch(
  url: string,
  cookieHeader: string,
  method: string,
  body: string | URLSearchParams | undefined,
  extraHeaders: Record<string, string>,
  followRedirects: boolean
): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    const doRequest = (reqUrl: string, redirectCount = 0) => {
      const parsed = new URL(reqUrl);
      const isHttps = parsed.protocol === "https:";
      const mod = isHttps ? https : (http as any);

      let bodyStr: string | undefined;
      let contentType: string | undefined;
      if (body instanceof URLSearchParams) {
        bodyStr = body.toString();
        contentType = "application/x-www-form-urlencoded";
      } else if (typeof body === "string") {
        bodyStr = body;
        contentType = "application/json";
      }

      const reqOptions: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          Cookie: cookieHeader,
          "User-Agent": "Mozilla/5.0 (compatible; edookit-legacy-mcp/1.0)",
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "cs,en;q=0.9",
          ...(contentType ? { "Content-Type": contentType } : {}),
          ...(bodyStr ? { "Content-Length": String(Buffer.byteLength(bodyStr)) } : {}),
          ...extraHeaders,
        },
      };

      const req = mod.request(reqOptions, (res: any) => {
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers as Record<string, any>)) {
          resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
        }

        if (
          followRedirects &&
          redirectCount < 5 &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          resHeaders["location"]
        ) {
          const loc = resHeaders["location"];
          const nextUrl = loc.startsWith("http") ? loc : `https://${parsed.hostname}${loc}`;
          res.resume();
          doRequest(nextUrl, redirectCount + 1);
          return;
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: resHeaders, body: data, finalUrl: reqUrl })
        );
      });

      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    };

    doRequest(url);
  });
}

export function parseHtml(html: string) {
  return cheerioLoad(html);
}

export function extractToken(html: string, formSelector = "form"): string {
  const $ = parseHtml(html);
  return ($(formSelector).find('input[name="_token"]').val() as string) ?? "";
}
