// lib/privacy.js
// Second line of defence: even if a stale content script captures a sensitive
// page, the service worker refuses to store it (and purges old copies).
// Keep in sync with EXCLUDED_DOMAIN_PATTERNS in content-script.js.

export const EXCLUDED_DOMAIN_PATTERNS = [
  /bank/i, /chase\.com/i, /wellsfargo\.com/i, /paypal\.com/i, /paytm/i, /phonepe/i, /razorpay/i,
  /health/i, /mychart/i, /webmd\.com/i,
  /^mail\./i, /mail\.google\.com/i, /outlook\./i, /mail\.yahoo\.com/i, /proton\.me/i,
  /web\.whatsapp\.com/i, /web\.telegram\.org/i, /discord\.com/i, /calendar\.google\.com/i,
  /login\./i, /accounts\./i, /signin\./i, /auth\./i, /myaccount\.google\.com/i,
];

export function isExcludedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return EXCLUDED_DOMAIN_PATTERNS.some((re) => re.test(host));
  } catch {
    return true; // unparseable URL -> don't store
  }
}