import { createTransport, type Transporter } from 'nodemailer';
import type { Mailer, PasswordResetMail } from '../../domain/auth/ports.js';

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Renders the Spanish password-reset message (plain text and HTML). */
export function renderPasswordResetMail(mail: PasswordResetMail): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = 'Restablece tu contraseña de Inventario';
  const text = [
    `Hola ${mail.fullName},`,
    '',
    'Recibimos una solicitud para restablecer la contraseña de tu cuenta.',
    `Abre este enlace para elegir una nueva (vale ${mail.expiresInMinutes} minutos y solo se puede usar una vez):`,
    '',
    mail.link,
    '',
    'Si no fuiste tú, ignora este mensaje: tu contraseña no cambiará.',
  ].join('\n');
  const html = `<p>Hola ${escapeHtml(mail.fullName)},</p>
<p>Recibimos una solicitud para restablecer la contraseña de tu cuenta.</p>
<p><a href="${escapeHtml(mail.link)}">Elegir una contraseña nueva</a></p>
<p>El enlace vale ${mail.expiresInMinutes} minutos y solo se puede usar una vez.</p>
<p>Si no fuiste tú, ignora este mensaje: tu contraseña no cambiará.</p>`;
  return { subject, text, html };
}

/** SMTP adapter (nodemailer). In development it points at Mailpit; in production at the provider. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly settings: SmtpSettings) {
    this.transport = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? '' } } : {}),
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    const message = renderPasswordResetMail(mail);
    await this.transport.sendMail({ from: this.settings.from, to: mail.to, ...message });
  }
}

/** Used when SMTP is not configured: every send fails, which the use case logs as auth.mail.failed. */
export class DisabledMailer implements Mailer {
  async sendPasswordReset(): Promise<void> {
    throw new Error('MailNotConfigured');
  }
}
