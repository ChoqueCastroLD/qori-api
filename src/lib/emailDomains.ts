// Allowlist of well-known consumer email providers. Custom/rare/disposable
// domains are rejected to reduce fake-account spam.
const ALLOWED = new Set<string>([
  // Google
  "gmail.com", "googlemail.com",
  // Microsoft
  "outlook.com", "outlook.es", "outlook.com.pe", "outlook.com.ar", "outlook.com.mx", "outlook.cl",
  "hotmail.com", "hotmail.es", "hotmail.com.pe", "hotmail.com.ar", "hotmail.com.mx", "hotmail.cl",
  "live.com", "live.com.pe", "live.com.mx", "live.com.ar", "live.cl", "live.es",
  "msn.com",
  // Yahoo
  "yahoo.com", "yahoo.es", "yahoo.com.pe", "yahoo.com.mx", "yahoo.com.ar", "yahoo.cl",
  "ymail.com", "rocketmail.com",
  // Apple
  "icloud.com", "me.com", "mac.com",
  // Proton
  "proton.me", "protonmail.com",
  // Otros conocidos
  "aol.com", "gmx.com", "gmx.es", "zoho.com", "mail.com", "yandex.com",
]);

/** True if the email's domain is a known consumer provider. */
export function isAllowedEmailDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return ALLOWED.has(domain);
}

export const ALLOWED_DOMAINS = [...ALLOWED];
