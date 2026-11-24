export interface LocalSettings {
  enabled: boolean;
  consentVersion: number;
  approvedOrigins: string[];
}

export const DEFAULT_SETTINGS: LocalSettings = {
  enabled: false,
  consentVersion: 0,
  approvedOrigins: [],
};

export const CONSENT_VERSION = 1;
const SENSITIVE_PATH =
  /(?:^|\/)(?:login|log-in|signin|sign-in|account|accounts|inbox|messages?|messaging|direct|chats?|checkout|banking|billing|settings|password|payment|private)(?:\/|$)/i;

export function isEligiblePage(url: string, settings: LocalSettings, hasPassword = false): boolean {
  if (!settings.enabled || settings.consentVersion !== CONSENT_VERSION || hasPassword) return false;
  const origin = normalizeOrigin(url);
  if (!origin || !settings.approvedOrigins.includes(origin)) return false;
  try {
    const parsed = new URL(url);
    const routes = [parsed.pathname, parsed.hash.replace(/^#!?/, '')];
    for (const key of [
      'route',
      'path',
      'page',
      'pathname',
      'next',
      'redirect',
      'redirect_uri',
      'return',
    ]) {
      const value = parsed.searchParams.get(key);
      if (value) routes.push(value);
    }
    return routes.every((route) => !SENSITIVE_PATH.test(decodeURIComponent(route)));
  } catch {
    return false;
  }
}

export function normalizeOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.username || url.password) return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (
      !loopback &&
      (url.hostname.endsWith('.local') ||
        !url.hostname.includes('.') ||
        /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
        url.hostname.startsWith('['))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Browser match patterns cannot include ports. Admission still uses the exact origin. */
export function hostPermissionPattern(input: string): string | null {
  const origin = normalizeOrigin(input);
  if (!origin) return null;
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeSettings(value: unknown): LocalSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  const obj = value as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    consentVersion: obj.consentVersion === CONSENT_VERSION ? CONSENT_VERSION : 0,
    approvedOrigins: Array.isArray(obj.approvedOrigins)
      ? [
          ...new Set(
            obj.approvedOrigins.filter(
              (origin): origin is string =>
                typeof origin === 'string' && normalizeOrigin(origin) === origin,
            ),
          ),
        ].slice(0, 100)
      : [],
  };
}
