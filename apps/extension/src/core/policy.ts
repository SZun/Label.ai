import { isLocalTestUrl, LOCAL_TEST_BUILD } from './local-test';

export interface LocalSettings {
  enabled: boolean;
  consentVersion: number;
}

export const CONSENT_VERSION = 2;
export const DEFAULT_SETTINGS: LocalSettings = {
  enabled: true,
  consentVersion: CONSENT_VERSION,
};
export const PAUSED_SETTINGS: LocalSettings = {
  enabled: false,
  consentVersion: CONSENT_VERSION,
};

/** The native installation grant, subject to browser-controlled site access. */
export const SCAN_MATCHES = LOCAL_TEST_BUILD
  ? ['http://localhost/*', 'http://127.0.0.1/*']
  : ['http://*/*', 'https://*/*'];
const SENSITIVE_PATH =
  /(?:^|\/)(?:login|log-in|signin|sign-in|account|accounts|inbox|messages?|messaging|direct|chats?|checkout|banking|billing|settings|password|payment|private)(?:\/|$)/i;

export function isEligiblePage(url: string, settings: LocalSettings, hasPassword = false): boolean {
  if (!settings.enabled || settings.consentVersion !== CONSENT_VERSION || hasPassword) return false;
  const origin = normalizeOrigin(url);
  if (!origin) return false;
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
  if (LOCAL_TEST_BUILD && !isLocalTestUrl(input)) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password) return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
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

/** Browser match patterns cannot include ports; use the sender's actual host and scheme. */
export function hostPermissionPattern(input: string): string | null {
  const origin = normalizeOrigin(input);
  if (!origin) return null;
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeSettings(value: unknown): LocalSettings {
  // A new installation starts automatically. Explicit legacy pauses survive
  // migration; old per-site selections are discarded after the browser grants
  // the new install-time host permissions.
  if (value === undefined) return { ...DEFAULT_SETTINGS };
  if (!value || typeof value !== 'object') return { ...PAUSED_SETTINGS };
  const obj = value as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    consentVersion: CONSENT_VERSION,
  };
}

function hasActivePasswordField(doc: Document): boolean {
  const fields = doc.querySelectorAll('input[type="password"]');
  for (const field of fields) {
    // Public feeds may keep a dormant sign-in dialog mounted beside the player.
    let layer: Element | null = field;
    while (layer && doc.defaultView?.getComputedStyle(layer).display !== 'none') {
      if (!layer.parentElement) return true;
      layer = layer.parentElement;
    }
  }
  return false;
}

/** Verify the complete same-origin frame ancestry before reading any visible pixels. */
export function eligibleDocumentChain(frame: Window, settings: LocalSettings): boolean {
  try {
    const origin = frame.location.origin;
    let ancestor = frame;
    while (true) {
      if (
        ancestor.location.origin !== origin ||
        !isEligiblePage(ancestor.location.href, settings, hasActivePasswordField(ancestor.document))
      )
        return false;
      if (ancestor.parent === ancestor) return true;
      ancestor = ancestor.parent;
    }
  } catch {
    // Cross-origin or opaque frame ancestry cannot establish a private-context decision.
    return false;
  }
}
