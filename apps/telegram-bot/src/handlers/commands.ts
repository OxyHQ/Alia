import { Context } from 'telegraf';

export async function handleHelp(ctx: Context) {
  const helpMessage = `
🤖 *Alia AI Bot - Help*

*Getting Started:*
/start - Get authentication link
/status - Check your account status
/logout - Disconnect your account

*Chat Commands:*
Just send me a message to chat with Alia!
/new - Start a new conversation
/history - View your conversation history

*Other Commands:*
/help - Show this help message

*How to Use:*
1. Send any message or /start
2. Click the authentication link to sign in
3. Return to Telegram and start chatting!

*Example:*
You: Hello, who are you?
Alia: I'm Alia, your AI assistant! How can I help you today?
`;

  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
}
