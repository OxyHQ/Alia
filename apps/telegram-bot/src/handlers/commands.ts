import { Context } from 'telegraf';

export async function handleHelp(ctx: Context) {
  const helpMessage = `
🤖 *Alia AI Bot - Help*

*Authentication Commands:*
/start - Start the bot and get authentication instructions
/login <email> <password> - Login with your credentials
/logout - Disconnect your account
/status - Check your account status

*Chat Commands:*
Just send me a message to chat with Alia!
/new - Start a new conversation
/history - View your conversation history

*Other Commands:*
/help - Show this help message

*How to Use:*
1. Use /start to begin
2. Authenticate using the provided link or /login command
3. Start chatting by sending any message!

*Example:*
You: Hello, who are you?
Alia: I'm Alia, your AI assistant! How can I help you today?
`;

  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
}
