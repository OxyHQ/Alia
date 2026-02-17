# Alia App

Main Alia application built with Expo Router and React Native. Runs on web, iOS, and Android.

## Features

- **Multi-platform** — Single codebase for web, iOS, and Android
- **Expo Router** — File-based routing with nested layouts
- **NativeWind** — Tailwind CSS for React Native via NativeWind
- **AI Chat** — Streaming chat with markdown rendering and rich blocks
- **Voice Mode** — Real-time voice conversations via WebRTC
- **Memory System** — User memories, preferences, and context
- **Developer Portal** — API key management and app creation
- **Billing** — Subscription plans and credit purchases via Stripe
- **Organizations** — Team workspaces with member management
- **Automations** — User-configured automated workflows
- **Canvas** — Visual workflow builder with node-based execution
- **Agent Runtime** — Live agent activity terminal (xterm.js), hire agents, owner controls
- **Skills** — Browseable skill library with prompt templates
- **Sidebar** — Conversation history, folders, favorites, pinned items
- **i18n** — Internationalization with reactive language switching
- **Rich Blocks** — Custom ALIA_ tagged components (COMPACTLIST, BANNER, COMPARISON, TIMELINE, IMAGE, CREDIBILITY)

## Route Structure

```
app/
├── _layout.tsx                # Root layout (auth provider, theme, fonts)
├── +html.tsx                  # Web HTML template
├── +not-found.tsx             # 404 page
├── (app)/                     # Main authenticated layout
│   ├── _layout.tsx            # App shell (sidebar + content)
│   ├── index.tsx              # Home / new chat
│   ├── c/[id].tsx             # Chat conversation by ID
│   ├── login.tsx              # Login screen
│   ├── register.tsx           # Registration screen
│   ├── forgot-password.tsx    # Forgot password
│   ├── reset-password.tsx     # Reset password
│   ├── agents.tsx             # Agent browser
│   ├── agents/[id].tsx        # Agent detail (terminal, hire, owner controls)
│   ├── agents/create.tsx      # Create agent via AI prompt
│   ├── agents/edit/[id].tsx   # Edit agent details
│   ├── agents/teams.tsx       # Agent teams list
│   ├── agents/teams/[id].tsx  # Team detail
│   ├── agents/teams/create.tsx # Create team via AI prompt
│   ├── library.tsx            # Content library
│   ├── favorites.tsx          # Favorited items
│   ├── skills.tsx             # Skills directory
│   ├── skills/[id].tsx        # Skill detail
│   ├── automations.tsx        # Automations list
│   ├── roles.tsx              # Roles/personas list
│   ├── roles/[id].tsx         # Role detail
│   ├── notifications.tsx      # Notifications
│   ├── settings/              # Settings pages
│   │   ├── index.tsx          # General settings
│   │   ├── personalization.tsx
│   │   ├── memory.tsx
│   │   ├── usage.tsx
│   │   ├── connectors.tsx
│   │   ├── feedback.tsx
│   │   ├── telegram-gateway.tsx
│   │   ├── whatsapp.tsx
│   │   └── signal-gateway.tsx
│   ├── authorize/             # OAuth app authorization
│   ├── invite/[code].tsx      # Invite acceptance
│   ├── channel-auth.tsx       # Channel authentication
│   └── telegram-auth.tsx      # Telegram account linking
└── (biglayout)/               # Full-screen layouts
    ├── _layout.tsx
    ├── subscribe.tsx          # Subscription page
    ├── codea-subscribe.tsx    # Codea subscription
    └── download.tsx           # App download page
```

## State Management

### Zustand Stores

| Store | Purpose |
|-------|---------|
| `model-store` | Selected AI model |
| `ui-store` | Sidebar state, panels, modals |
| `folders-store` | Conversation folders |
| `favorites-store` | Favorited conversations |
| `pinned-store` | Pinned conversations |
| `library-store` | Content library |
| `projects-store` | Projects/workspaces |
| `organization-store` | Organization data |
| `agents-store` | Agent CRUD and hiring |
| `roles-store` | Custom roles/personas |
| `theme-store` | Theme and accent color |
| `i18n-store` | Language selection |
| `user-data-store` | User profile and preferences |

### React Query Hooks

| Hook | Purpose |
|------|---------|
| `use-conversations` | Conversation CRUD and list |
| `use-credits` | Credit balance and usage |
| `use-billing` | Subscription and plans |
| `use-developer` | Developer apps and API keys |
| `use-organization` | Organization management |
| `use-referrals` | Referral codes |
| `use-voice-chat` | Voice mode state |
| `use-realtime-voice` | WebRTC voice streaming |
| `use-speech-to-text` | Audio transcription |
| `use-agent-teams` | Agent team CRUD and list |

## AI Integration

The app uses a custom streaming hook that communicates with the API's OpenAI-compatible endpoint:

```tsx
// Streaming chat via /v1/chat/completions
const { messages, isStreaming, sendMessage } = useStreamingChat({
  conversationId,
  model: selectedModel,
});
```

Features:
- SSE streaming with progressive message rendering
- Reasoning/thinking display (chain-of-thought)
- Tool call visualization
- Rich block rendering (ALIA_COMPACTLIST, ALIA_BANNER, etc.)
- Image and file attachments
- Conversation auto-save with title generation

## UI Components

Components in [components/ui/](components/ui/) follow shadcn/ui patterns adapted for React Native:

`Button`, `Input`, `Textarea`, `Card`, `Dialog`, `Sheet`, `DropdownMenu`, `Command`, `Collapsible`, `ToggleGroup`, `Separator`, `Skeleton`, `ScrollArea`, `Avatar`, `Label`, `Kbd`, `Icon`, `Panel`, `ChatTextInput`, `Markdown`, `RichBlocks`, `Reasoning`

### PromptInput

A self-contained, props-driven chat input component in [components/ui/prompt-input/](components/ui/prompt-input/). All sub-components (textarea, attachments, autocomplete, add menu, mic, submit button) are rendered internally — consumers only import `<PromptInput />` and configure via props.

```tsx
// Simple usage (create screens)
<PromptInput
  value={text}
  onValueChange={setText}
  onSubmit={handleSubmit}
  placeholder="Describe your agent..."
  autocomplete
/>

// Full usage (chat screen)
<PromptInput
  value={text}
  onValueChange={setText}
  onSubmit={handleSubmit}
  isLoading={isLoading}
  leadingAddMenu              // standalone "+" button to the left
  autocomplete={isMainScreen} // suggestions above the box
  actionsLeft={<>...</>}      // custom left actions (search, modes, menus)
  onStop={onStop}             // stop button when loading
  emptyAction={<VoiceBtn />}  // shown when input is empty
  attachments={attachments}   // controlled attachments
  onAddAttachment={add}
  onRemoveAttachment={remove}
  onImagePaste={handlePaste}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `value` | `string` | Controlled input value |
| `onValueChange` | `(v: string) => void` | Input change handler |
| `onSubmit` | `() => void` | Submit handler |
| `isLoading` | `boolean` | Shows loading state |
| `disabled` | `boolean` | Disables input |
| `placeholder` | `string` | Textarea placeholder |
| `autocomplete` | `boolean` | Shows autocomplete suggestions above box |
| `leadingAddMenu` | `boolean` | Standalone "+" add menu to the left of the box |
| `actionsLeft` | `ReactNode` | Custom left-side actions (replaces default add menu) |
| `onStop` | `() => void` | Stop button handler (shown when loading) |
| `emptyAction` | `ReactNode` | Custom action shown when input is empty |
| `attachments` | `Attachment[]` | Controlled attachments (internal state if omitted) |
| `onAddAttachment` | `(a: Attachment) => void` | Add attachment handler |
| `onRemoveAttachment` | `(id: string) => void` | Remove attachment handler |
| `onImagePaste` | `(files: File[]) => void` | Image paste handler |

## Development

```bash
# From the monorepo root
npm run dev:app

# Or from apps/app
npm start
```

### Run on specific platforms:

```bash
npm run web       # Web
npm run android   # Android
npm run ios       # iOS
```

## Configuration

### API URL

The API URL configuration is in [lib/config.ts](lib/config.ts):

- **Development**: `http://localhost:3000`
- **Staging**: `https://staging-api.alia.onl`
- **Production**: `https://api.alia.onl`

## Production Build

```bash
# Install EAS CLI
npm install -g eas-cli

# Build
eas build --platform android
eas build --platform ios
eas build --platform all
```

## Resources

- [Expo Documentation](https://docs.expo.dev/)
- [Expo Router](https://docs.expo.dev/router/introduction/)
- [NativeWind](https://www.nativewind.dev/)
