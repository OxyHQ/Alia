# Alia Agents

Alia is a multi-agent AI platform where each agent specializes in a specific domain to provide you with the best possible assistance.

## Available Agents

### 1. **Alia** - General Assistant
The main and most versatile agent on the platform.

**Specialties:**
- General conversations
- Help with everyday tasks
- Quick answers to a variety of questions
- Coordination with other specialized agents

**When to use:**
- When you're not sure which agent to use
- For general tasks and conversations
- As an entry point to the platform

---

### 2. **Alia Developer** - Development Expert
Specialized in software architecture, debugging, and development.

**Specialties:**
- Software architecture and design patterns
- Debugging and error resolution
- Code reviews and optimizations
- Programming best practices
- Multiple languages: JavaScript, TypeScript, Python, Go, Rust, Java, etc.
- Modern frameworks: React, Next.js, Express, FastAPI, etc.
- DevOps and CI/CD

**When to use:**
- When you need help with code
- To design software architectures
- Debugging and solving technical problems
- Performance optimization
- Code reviews

**Examples:**
```
"Help me design the architecture for a real-time chat application"
"I have an error in my React code, can you help me?"
"What's the best way to implement JWT authentication?"
"Review this code and suggest improvements"
```

---

### 3. **Alia Social Manager** - Social Media Expert
Specialized in content strategy and social media management.

**Specialties:**
- Social media content strategy
- Persuasive copywriting
- Editorial calendar
- Trend analysis
- Community management
- Social media crisis management
- Engagement optimization

**When to use:**
- Creating content for social media
- Digital marketing strategies
- Campaign planning
- Social media metrics analysis
- Online community management

**Examples:**
```
"I need a content strategy for Instagram"
"Help me write engaging posts for LinkedIn"
"Create an editorial calendar for next month"
"How can I increase engagement on my social media?"
```

---

### 4. **Alia Business** - Strategic Analyst
Specialized in market strategy and business analysis.

**Specialties:**
- Market and competitive analysis
- Business strategy
- Business plan
- Financial analysis
- Business models
- Growth hacking
- Metrics and KPIs

**When to use:**
- Strategic business planning
- Market analysis
- Opportunity evaluation
- Process optimization
- Business decisions

**Examples:**
```
"I need to analyze the competition in the SaaS sector"
"Help me create a business plan for my startup"
"How can I improve my sales funnel?"
"Analyze these metrics and give me insights"
```

---

## Autonomous Agent Runtime

Alia agents can run autonomously 24/7, executing tasks independently with access to tools, Docker containers, and other agents.

### How It Works

1. **Hire an Agent** — Give an agent a task via the app or API (`POST /agents/:id/hire`)
2. **Agent Session** — A session is created and the agent starts working autonomously
3. **Tool Usage** — The agent uses tools (web search, code execution, file I/O, etc.) to complete the task
4. **Live Terminal** — Watch agent activity in real-time via the xterm.js terminal on the agent detail screen
5. **Completion** — The agent calls `completeTask` when done, with a summary of results

### Smart Model Selection

Agents intelligently pick the right AI model based on task complexity:

- **Simple tasks** (quick lookups, formatting) → cheapest available model (e.g. `alia-lite`)
- **Medium tasks** (analysis, writing) → balanced model (e.g. `alia-v1`)
- **Complex tasks** (multi-step reasoning, coding) → most capable model (e.g. `alia-v1-pro`)

Owners configure which models each agent can use via the `allowedModels` field. The agent then selects the best model from that list for each step.

### Available Tools

| Tool | Description |
|------|-------------|
| `getCurrentDate` | Get current date/time |
| `googleSearch` | Search the web |
| `webScraper` | Extract content from web pages |
| `saveMemory` | Persist information across sessions |
| `sendTelegram` | Send messages via Telegram |
| `hireAgent` | Delegate work to another agent |
| `createContainer` | Spin up a sandboxed Docker container |
| `exec` | Execute commands inside a container |
| `writeFile` | Write files inside a container |
| `readFile` | Read files from a container |
| `listFiles` | List directory contents in a container |
| `exposePort` | Expose a container port for preview |
| `snapshotContainer` | Save container state as an image |
| `destroyContainer` | Tear down a container |
| `completeTask` | Mark the task as done with a summary |
| `createTrigger` | Create scheduled/webhook triggers via natural language |
| `listTriggers` | List user's active triggers and routines |
| `updateTrigger` | Update trigger schedule, prompt, or enable/disable |
| `deleteTrigger` | Delete a trigger |

### Agent-to-Agent Delegation

Agents can hire other agents for subtasks using the `hireAgent` tool. This creates a child session with:
- A depth limit of 3 to prevent infinite recursion
- Full activity streaming to the parent agent's terminal
- Automatic resource cleanup on completion

### Owner Controls

Agent owners can:
- **Toggle status** — Switch between `active` / `idle` / `offline`
- **Configure models** — Set which AI models the agent can use (`allowedModels`)
- **Set system prompt** — Custom instructions for the agent
- **Cancel sessions** — Stop a running session at any time
- **View sessions** — Browse session history with stats (tokens, steps, duration)

---

## Proactive Intelligence

Alia doesn't just respond to messages — it can proactively reach out, monitor things, and run tasks on autopilot. This is powered by three interconnected systems.

### Triggers (Scheduled AI Tasks)

Triggers are automated AI tasks that run on a schedule, on webhook, or on integration events. When a trigger fires, Alia executes an AI prompt with full tool access (web search, integrations, etc.) and delivers the result as a notification via push, in-app, Telegram, or other connected channels.

**Types:**
- **Schedule** — Cron expressions, daily at a specific time, or interval-based (every N minutes)
- **Webhook** — External services POST to a unique URL, Alia processes the payload with AI
- **Integration Event** — Fires when connected services emit events (GitHub push, Linear issue created, etc.)

**Creating triggers conversationally:**

Users can create triggers directly in chat using natural language:

```
"Every morning at 8am, check my GitHub PRs and summarize them on Telegram"
"Every Friday, search for news about AI agents and send me a digest"
"Set a reminder to review my monthly budget on the 1st of each month"
```

Alia parses these into structured trigger configs using the `createTrigger` tool.

### Notifications (Multi-Channel Delivery)

When a trigger completes, results are delivered as notifications across the user's connected channels:

- **In-app** — Real-time via Socket.io, shown in the notification feed
- **Push** — Expo push notifications to registered mobile devices (iOS/Android)
- **Telegram** — Sent to linked Telegram account
- **Discord / WhatsApp / Slack** — Sent to connected accounts

Notification types: `trigger_result`, `proactive_insight`, `daily_briefing`, `price_alert`, `integration_event`, `reminder`

### Proactive Insights (After-Chat Analysis)

After conversations, Alia analyzes whether it should proactively suggest:
- A **reminder** for mentioned future events or deadlines
- A **monitoring trigger** for things that change over time
- A **routine** for recurring needs

These appear as personalized suggestions in the user's next session.

### Daily Briefing

A personalized morning summary assembled from:
- User interests and occupation (from memory)
- Connected integrations (calendar events, GitHub PRs, etc.)
- Web-searched news relevant to the user

Created as a schedule trigger, delivered via notifications at the user's preferred time.

---

## Switching Between Agents

In the Alia interface, you can easily switch between agents based on your needs:

1. **In the App/Web**: Use the agent selector at the top
2. **In the API**: Specify the agent in the `agent` or `model` parameter

## Best Practices

### To get better results:

1. **Be specific**: Provide clear context about what you need
2. **Use the right agent**: Each agent is optimized for its domain
3. **Iterate**: Don't hesitate to refine your questions based on the responses
4. **Combine agents**: You can use multiple agents in a single session

### Example workflows:

**Case 1: Product Launch**
1. **Alia Business** → Market analysis and strategy
2. **Alia Developer** → Product development
3. **Alia Social Manager** → Social media launch strategy

**Case 2: Technical Problem Solving**
1. **Alia** → Problem description
2. **Alia Developer** → Deep technical analysis and solution

**Case 3: Marketing Campaign**
1. **Alia Business** → Define objectives and metrics
2. **Alia Social Manager** → Create content and strategy
3. **Alia Business** → Analyze results and optimize

---

## Alia Model Tiers

Alia abstracts AI complexity behind a simple tier system. You choose the right tier for your task — Alia handles provider routing, fallbacks, and optimization automatically.

| Model | Best For | Credit Multiplier |
|-------|----------|-------------------|
| `alia-lite` | Quick answers, simple tasks | 0.5x |
| `alia-v1` | Everyday conversations | 1x |
| `alia-v1-pro` | Complex reasoning | 3x |
| `alia-v1-pro-max` | Most demanding tasks | 5x |

Specialized models are also available for vision, audio, voice, coding, and more. See the [Developer API Reference](api-reference.md) for the full list.

---

© 2026 Alia
