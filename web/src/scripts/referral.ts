// Partner referral attribution (the DrWealth-style collaborations).
//
// A partner shares the site as https://rho-market-navigator.vercel.app/?ref=drwealth.
// captureRef() (run on every page via Base.astro) stores that tag in
// localStorage for ATTRIBUTION_DAYS, so it survives the visitor browsing
// around or coming back days later. decorateSubscribeLinks() (run where
// Subscribe buttons exist) appends the stored tag to each Stripe payment-link
// href as ?client_reference_id=<ref>, which Stripe echoes back on
// checkout.session.completed — the webhook writes it to the sheet's
// Referral Source column (Q) and stamps it on the subscription's metadata.
//
// Last-touch: landing with a new valid ?ref= overwrites a stored one.

const KEY = 'nav_ref';
const ATTRIBUTION_DAYS = 30;

// Stripe's client_reference_id accepts alphanumerics, dashes and underscores
// (max 200 chars). Anything else would make Stripe drop the whole param, so
// reject bad values here rather than lose the attribution silently.
const VALID_REF = /^[A-Za-z0-9_-]{1,64}$/;

interface StoredRef {
  ref: string;
  ts: number; // epoch ms when captured
}

/** Store ?ref=<partner> from the current URL, if present and valid. */
export function captureRef(): void {
  try {
    const ref = new URLSearchParams(window.location.search).get('ref')?.trim();
    if (!ref || !VALID_REF.test(ref)) return;
    const stored: StoredRef = { ref: ref.toLowerCase(), ts: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // localStorage unavailable (private mode with storage blocked) — attribution
    // is best-effort, never break the page over it.
  }
}

/** The stored partner ref, or null if absent, expired, or malformed. */
export function getRef(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredRef;
    if (!stored?.ref || !VALID_REF.test(stored.ref)) return null;
    const ageDays = (Date.now() - (stored.ts || 0)) / (1000 * 60 * 60 * 24);
    if (ageDays > ATTRIBUTION_DAYS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return stored.ref;
  } catch {
    return null;
  }
}

/**
 * Append ?client_reference_id=<stored ref> to every matching link. Uses the
 * URL API so it composes with params added later (e.g. prefilled_promo_code).
 */
export function decorateSubscribeLinks(selector: string): void {
  const ref = getRef();
  if (!ref) return;
  document.querySelectorAll<HTMLAnchorElement>(selector).forEach((a) => {
    try {
      const url = new URL(a.href);
      url.searchParams.set('client_reference_id', ref);
      a.href = url.toString();
    } catch {
      // Malformed href — leave it untouched.
    }
  });
}
