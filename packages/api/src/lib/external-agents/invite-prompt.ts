import { EXTERNAL_PAIRING_TTL_MS } from '../../domain/external-agent.js';

export type InviteLocale = 'en' | 'es';

export function inviteLocaleOf(value: unknown): InviteLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/**
 * The text a person pastes into Claude Code, Codex or OpenCode (ADR 0028).
 *
 * It carries a single-use code and one command, never a long-lived secret: the code only binds a
 * machine to an agent, and the daemon signs in to Oxy on its own. It is written to be read by a
 * model, so it says what to run, what to show the person, and when to stop.
 */
export function buildInvitePrompt(input: { code: string; locale: InviteLocale }): string {
  const minutes = Math.round(EXTERNAL_PAIRING_TTL_MS / 60_000);
  const command = `npx -y @alia-codea/cli@latest connect --code ${input.code} --cli <claude|codex|opencode>`;
  if (input.locale === 'es') {
    return [
      'Quiero conectarte a Alia (https://alia.onl) para poder hablar contigo desde allí y que mis otros agentes te escriban.',
      '',
      'Ejecuta esto en una terminal de este equipo, desde la carpeta en la que quiero que trabajes (podrás editar archivos ahí), y déjalo corriendo en segundo plano:',
      '',
      `  ${command}`,
      '',
      'Sustituye <claude|codex|opencode> por el que seas tú. La primera vez imprimirá un enlace para iniciar sesión en Oxy: enséñamelo y espera a que lo apruebe.',
      'Cuando muestre "Conectado", dímelo y no hagas nada más: desde ahí el proceso atiende los mensajes de Alia con esta misma herramienta y mi sesión.',
      `El código es de un solo uso y caduca en ${minutes} minutos. No instales nada más ni cambies ninguna configuración.`,
    ].join('\n');
  }
  return [
    "I'm connecting you to Alia (https://alia.onl) so I can talk to you from there and my other agents can message you.",
    '',
    'Run this in a terminal on this machine, from the folder I want you to work in (you will be able to edit files there), and leave it running in the background:',
    '',
    `  ${command}`,
    '',
    'Replace <claude|codex|opencode> with whichever one you are. The first run prints a link to sign in to Oxy: show it to me and wait for me to approve it.',
    'When it prints "Connected", tell me and do nothing else — from then on that process answers Alia\'s messages using this same tool and my login.',
    `The code is single-use and expires in ${minutes} minutes. Do not install anything else or change any configuration.`,
  ].join('\n');
}
