// Transactional email via Resend. Branded to match qori.cc (white, clean,
// emerald accent). The API key is read from env (never committed).

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const EMAIL_FROM = process.env.EMAIL_FROM ?? "qori <no-reply@qori.cc>";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://qori.cc";

/** Low-level send. Resolves false (and logs) if not configured or on error. */
export async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY no configurada; email omitido:", opts.subject);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: opts.to, subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      console.error("Resend error", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("Resend fetch failed", e);
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
            <img src="${WEB_ORIGIN}/logo.png" width="24" height="24" alt="" style="vertical-align:middle;margin-right:8px" />qori
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
        <a href="${WEB_ORIGIN}" style="color:#94a3b8">qori.cc</a> · ¿Dudas? <a href="mailto:support@qori.cc" style="color:#94a3b8">support@qori.cc</a>
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

export function verificationCodeEmail(code: string): { subject: string; html: string } {
  const boxed = `<div style="margin:20px 0;text-align:center">
    <span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:10px;color:#0f172a;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:14px;padding:14px 22px">${code}</span>
  </div>`;
  return {
    subject: `${code} es tu código de verificación · qori`,
    html: template({
      heading: "Tu código de verificación",
      body: `Ingresa este código para crear tu cuenta en qori. Vence en 15 minutos.${boxed}`,
      footnote: "Si no estás creando una cuenta, ignora este mensaje.",
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

export function purchaseEmail(raffleTitle: string, numbers: number[], slug: string): { subject: string; html: string } {
  const chips = numbers
    .map((n) => `<span style="display:inline-block;background:#f1f5f9;border-radius:8px;padding:4px 10px;margin:3px;font-family:monospace;font-weight:700;color:#0f172a">#${n}</span>`)
    .join("");
  return {
    subject: `Tickets confirmados · ${raffleTitle}`,
    html: template({
      heading: "¡Ya estás participando!",
      body: `Compraste ${numbers.length} ticket(s) de <strong>${raffleTitle}</strong>. Tus números:<div style="margin-top:12px">${chips}</div>`,
      cta: { label: "Ver el sorteo", url: `${WEB_ORIGIN}/sorteos/${slug}` },
    }),
  };
}

export function closingSoonEmail(raffleTitle: string, slug: string): { subject: string; html: string } {
  return {
    subject: `Se sortea pronto: ${raffleTitle}`,
    html: template({
      heading: "Tu sorteo está por comenzar",
      body: `El sorteo de <strong>${raffleTitle}</strong> se realizará muy pronto. Prepárate para verlo en vivo: el show revela al ganador etapa por etapa.`,
      cta: { label: "Ver el sorteo", url: `${WEB_ORIGIN}/sorteos/${slug}` },
    }),
  };
}

export function startingSoonEmail(raffleTitle: string, slug: string): { subject: string; html: string } {
  return {
    subject: `Empieza en minutos: ${raffleTitle}`,
    html: template({
      heading: "Tu sorteo empieza en unos minutos",
      body: `El sorteo de <strong>${raffleTitle}</strong> comienza muy pronto. Entra ahora y déjalo abierto: cuando arranque, el show se reproduce en vivo y sincronizado para todos.`,
      cta: { label: "Ir al sorteo", url: `${WEB_ORIGIN}/sorteos/${slug}` },
    }),
  };
}

export function drawLiveEmail(raffleTitle: string, slug: string): { subject: string; html: string } {
  return {
    subject: `EN VIVO ahora: se sortea ${raffleTitle}`,
    html: template({
      heading: "¡El sorteo es AHORA!",
      body: `El sorteo de <strong>${raffleTitle}</strong> está en vivo. Entra a ver el show y descubre al ganador en tiempo real, sincronizado para todos.`,
      cta: { label: "Ver en vivo", url: `${WEB_ORIGIN}/sorteos/${slug}/show` },
    }),
  };
}

export function resultsEmail(raffleTitle: string, slug: string, winnerNumbers: number[], lugares: number): { subject: string; html: string } {
  const nums = winnerNumbers.map((n) => "#" + n).join(", ");
  const cerca =
    lugares <= 1
      ? "Tu ticket quedó a un lugar de ganar. De todos los participantes, fuiste quien estuvo más cerca."
      : `Tu mejor ticket quedó a ${lugares} lugares de ganar.`;
  return {
    subject: `Resultado de ${raffleTitle}`,
    html: template({
      heading: "Estuviste cerca",
      body: `El sorteo de <strong>${raffleTitle}</strong> ya tiene ganador: <strong>${nums}</strong>. ${cerca} Puedes comprobarlo tú mismo en la repetición del sorteo. Gracias por participar; ya se vienen nuevos premios.`,
      cta: { label: "Ver la repetición", url: `${WEB_ORIGIN}/sorteos/${slug}/show` },
    }),
  };
}

export function postponedEmail(raffleTitle: string, slug: string, newDate: string, referralCode: string): { subject: string; html: string } {
  return {
    subject: `El sorteo de ${raffleTitle} se postergó 24 h`,
    html: template({
      heading: "Se postergó 24 horas",
      body: `El sorteo de <strong>${raffleTitle}</strong> aún no alcanza el mínimo de tickets, así que lo postergamos 24 h (nueva fecha: <strong>${newDate}</strong>). ¡Ayúdanos a llenarlo! Invita con tu código <strong>${referralCode}</strong> y gana 10 lingotes cuando tu referido haga su primera compra.`,
      cta: { label: "Ver el sorteo", url: `${WEB_ORIGIN}/sorteos/${slug}` },
    }),
  };
}

export function winnerEmail(raffleTitle: string, ticketNumber: number, slug: string): { subject: string; html: string } {
  return {
    subject: `¡Ganaste ${raffleTitle}!`,
    html: template({
      heading: "¡Felicidades, ganaste!",
      body: `Tu ticket <strong>#${ticketNumber}</strong> resultó ganador de <strong>${raffleTitle}</strong>. Te contactaremos para coordinar la entrega. También puedes ver y verificar el sorteo.`,
      cta: { label: "Ver el resultado", url: `${WEB_ORIGIN}/sorteos/${slug}` },
    }),
  };
}
