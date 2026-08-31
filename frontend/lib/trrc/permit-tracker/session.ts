const BASE_URL = "https://webapps.rrc.state.tx.us";

// RRC's own docs warn that automated tools retrieving volumes of data can
// degrade their systems and get the session cut off. Identify honestly and
// keep request volume bounded (search scoped to a handful of counties and a
// narrow date range per request, not a statewide bulk pull) rather than
// trying to look like a browser.
const USER_AGENT = "MineralFlowAIBot/1.0 (+internal drilling-permit tracker; contact via account owner)";

/**
 * Minimal cookie-jar-aware HTTP client for RRC's session-based public W-1
 * query app (search criteria and pagination are tied to a JSESSIONID cookie
 * set on the first request). One Session per search request.
 */
export class RrcSession {
  private cookies = new Map<string, string>();

  private captureCookies(res: Response) {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async get(path: string): Promise<string> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Cookie: this.cookieHeader(), "User-Agent": USER_AGENT },
    });
    this.captureCookies(res);
    if (!res.ok) throw new Error(`RRC GET ${path} failed: ${res.status} ${res.statusText}`);
    return res.text();
  }

  async post(path: string, body: URLSearchParams): Promise<string> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Cookie: this.cookieHeader(),
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    this.captureCookies(res);
    if (!res.ok) throw new Error(`RRC POST ${path} failed: ${res.status} ${res.statusText}`);
    return res.text();
  }

  /** Establishes the session by loading the search form once. */
  async init(): Promise<void> {
    await this.get("/DP/initializePublicQueryAction.do");
  }
}
