// Transactional email via Resend. Branded to match qori.cc (white, clean,
// emerald accent). The API key is read from env (never committed).

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const EMAIL_FROM = process.env.EMAIL_FROM ?? "qori <no-reply@qori.cc>";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";

/** Low-level send. Resolves false (and logs) if not configured or on error. */
export async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn("✉️  RESEND_API_KEY no configurada; email omitido:", opts.subject);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: opts.to, subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      console.error("✉️  Resend error", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("✉️  Resend fetch failed", e);
    return false;
  }
}

/** Branded HTML shell. `cta` is optional { label, url }. */
function template(opts: { heading: string; body: string; cta?: { label: string; url: string }; footnote?: string }): string {
  const btn = opts.cta
    ? `<tr><td style="padding:8px 0 4px">
         <a href="${opts.cta.url}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:12px">${opts.cta.label}</a>
       </td></tr>`
    : "";
  const foot = opts.footnote ? `<p style="margin:16px 0 0;font-size:13px;color:#94a3b8">${opts.footnote}</p>` : "";
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden">
        <tr><td style="padding:28px 32px 8px">
          <div style="font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-.5px">
            <span style="display:inline-block;width:10px;height:10px;background:#10b981;border-radius:50%;margin-right:8px"></span>qori
          </div>
        </td></tr>
        <tr><td style="padding:8px 32px 28px">
          <h1 style="margin:16px 0 8px;font-size:24px;color:#0f172a;font-weight:700">${opts.heading}</h1>
          <div style="font-size:15px;color:#475569;line-height:1.6">${opts.body}</div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px">${btn}</table>
          ${foot}
        </td></tr>
      </table>
      <p style="max-width:520px;margin:20px auto 0;font-size:12px;color:#94a3b8;text-align:center">
        Sorteos de productos transparentes y verificables. Juega con responsabilidad. Solo mayores de 18 años.<br>
        <a href="${WEB_ORIGIN}" style="color:#94a3b8">qori.cc</a>
      </p>
    </td></tr>
  </table></body></html>`;
}

export function verificationEmail(link: string): { subject: string; html: string } {
  return {
    subject: "Verifica tu correo en qori",
    html: template({
      heading: "Confirma tu correo",
      body: "¡Bienvenido a qori! Confirma tu correo para asegurar tu cuenta y poder cobrar si ganas.",
      cta: { label: "Verificar mi correo", url: link },
      footnote: "Si no creaste esta cuenta, puedes ignorar este mensaje.",
    }),
  };
}

export function topupApprovedEmail(lingotes: number, amountUsd: number): { subject: string; html: string } {
  return {
    subject: "Recarga confirmada",
    html: template({
      heading: "Tu recarga fue confirmada",
      body: `Acreditamos <strong>${lingotes} lingotes</strong> a tu cuenta (US$ ${(amountUsd / 100).toFixed(2)}). Ya puedes participar en los sorteos.`,
      cta: { label: "Ver sorteos", url: `${WEB_ORIGIN}/sorteos` },
    }),
  };
}

export function winnerEmail(raffleTitle: string, ticketNumber: number, slug: string): { subject: string; html: string } {
  return {
    subject: `🏆 ¡Ganaste ${raffleTitle}!`,
    html: template({
      heading: "¡Felicidades, ganaste! 🏆",
      body: `Tu boleto <strong>#${ticketNumber}</strong> resultó ganador de <strong>${raffleTitle}</strong>. Te contactaremos para coordinar la entrega. También puedes ver y verificar el sorteo.`,
      cta: { label: "Ver el resultado", url: `${WEB_ORIGIN}/sorteos/${slug}` },
    }),
  };
}
