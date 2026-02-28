/**
 * Email utility for Alia API
 *
 * Uses Resend as the email provider. Set RESEND_API_KEY in your environment
 * to enable email sending. If not configured, emails are logged to console
 * (useful for development).
 *
 * Optionally set RESEND_FROM_EMAIL to customize the sender address
 * (defaults to "Alia <noreply@alia.space>").
 */

import { Resend } from 'resend';
import { log } from './logger.js';

const emailLog = log.organization;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Alia <noreply@alia.space>';

let resend: Resend | null = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send an email via Resend.
 * Falls back to logging the email content when RESEND_API_KEY is not configured.
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const { to, subject, html, text } = options;

  if (!resend) {
    emailLog.warn(
      { to, subject },
      'RESEND_API_KEY not configured — email not sent (logged for dev)'
    );
    emailLog.info({ to, subject, html: html.substring(0, 200) }, 'Email content (dev)');
    return false;
  }

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html,
      ...(text ? { text } : {}),
    });

    if (error) {
      emailLog.error({ err: error, to, subject }, 'Resend API error');
      return false;
    }

    emailLog.info({ to, subject }, 'Email sent successfully');
    return true;
  } catch (err) {
    emailLog.error({ err, to, subject }, 'Failed to send email');
    return false;
  }
}

/**
 * Generate the HTML for an organization invitation email.
 */
export function buildInviteEmailHtml(params: {
  organizationName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
}): string {
  const { organizationName, inviterName, role, acceptUrl } = params;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">Alia</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px;color:#18181b;font-size:20px;font-weight:600;">You've been invited!</h2>
              <p style="margin:0 0 24px;color:#3f3f46;font-size:15px;line-height:1.6;">
                <strong>${inviterName}</strong> has invited you to join
                <strong>${organizationName}</strong> as a <strong>${role}</strong>.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:8px 0 24px;">
                    <a href="${acceptUrl}"
                       style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:600;">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;color:#71717a;font-size:13px;line-height:1.5;">
                This invitation expires in 7 days. If you don't have an Alia account yet,
                you'll be able to create one when you accept.
              </p>
              <p style="margin:0;color:#a1a1aa;font-size:12px;line-height:1.5;">
                If you weren't expecting this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;background:#fafafa;border-top:1px solid #f0f0f0;text-align:center;">
              <p style="margin:0;color:#a1a1aa;font-size:12px;">&copy; ${new Date().getFullYear()} Alia. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}
