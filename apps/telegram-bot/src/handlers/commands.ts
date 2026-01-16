import { Context } from 'telegraf';
import { Markup } from 'telegraf';

export async function handleHelp(ctx: Context) {
  const helpMessage = `
🤖 <b>Alia AI Bot - Help Guide</b>

<b>📌 Getting Started:</b>
• /start - Authenticate your account
• /status - Check account & credits
• /logout - Disconnect your account

<b>💬 Chatting:</b>
• Just send me any message to chat!
• /new - Start a fresh conversation
• /history - View past conversations

<b>❓ Need Help?</b>
• /help - Show this help message

<b>🎯 How It Works:</b>
1️⃣ Send /start to begin
2️⃣ Click the sign-in button
3️⃣ Authenticate in the Alia app
4️⃣ Return and start chatting!

<b>💡 Example:</b>
<i>You:</i> Hello, who are you?
<i>Alia:</i> I'm Alia, your AI assistant! How can I help you today?
`;

  await ctx.reply(helpMessage, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🚀 Get Started', 'start'),
        Markup.button.callback('📊 My Status', 'status')
      ],
      [Markup.button.url('🌐 Visit Alia App', 'https://alia.onl')]
    ])
  });
}
