# Alia App

Main Alia application built with Expo Router and React Native. Runs on web, iOS, and Android.

## Features

- **Expo Router** - File-based routing like Next.js
- **AI SDK** - Integration with @ai-sdk/react for chat streaming
- **NativeWind** - Tailwind CSS for React Native
- **Hugeicons** - Same icons as the admin
- **Consistent UI** - Components based on shadcn/ui adapted for RN
- **Multi-platform** - A single codebase for web, iOS, and Android

## Route Structure

```
app/
├── index.tsx         # Initial redirect
├── login.tsx         # /login - Login screen
├── register.tsx      # /register - Registration screen
└── (chat)/
    └── index.tsx     # /chat - Main chat screen
```

## Development

### Start the development server:

```bash
# From the monorepo root
npm run dev:app

# Or from apps/app
npm start
```

### Run on specific platforms:

```bash
# From the root
npm run web       # Web
npm run android   # Android
npm run ios       # iOS

# Or from apps/app
npm run web
npm run android
npm run ios
```

## Configuration

### API URL

The API URL configuration is located in [lib/config.ts](lib/config.ts):

- **Development**: `http://localhost:3000`
- **Staging**: `https://staging-api.alia.onl`
- **Production**: `https://api.alia.onl`

For local development, make sure the API is running at `http://localhost:3000`.

## UI Components

Components are in [components/ui/](components/ui/) and are designed to be compatible with React Native while maintaining the shadcn/ui API:

- `Button` - Buttons with variants (default, outline, ghost, etc.)
- `Input` - Styled text fields

## Screens

### Login ([app/login.tsx](app/login.tsx))
- Authentication form
- Email and password validation
- Navigation to registration

### Register ([app/register.tsx](app/register.tsx))
- Registration form
- Password confirmation
- Data validation

### Chat ([app/(chat)/index.tsx](app/(chat)/index.tsx))
- Integration with `useChat` hook from the AI SDK
- Real-time response streaming
- Markdown rendering
- Auto-scroll to new messages
- Consistent UI across web and mobile

## AI SDK Integration

The app uses the same system as the admin:

```tsx
const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
  api: `${config.apiUrl}/api/alia/chat`,
});
```

## Production Build

### Configure EAS:

```bash
# Install EAS CLI globally
npm install -g eas-cli

# Login
eas login

# Configure the project
eas build:configure
```

### Create builds:

```bash
# Android
npm run build:android

# iOS
npm run build:ios

# Both platforms
eas build --platform all
```

## Web vs Mobile

This application works on both web and mobile using the same codebase:

- **Web**: Renders with React Native Web (similar to how React Native works on the web)
- **iOS/Android**: Uses native React Native components

## Resources

- [Expo Documentation](https://docs.expo.dev/)
- [Expo Router](https://docs.expo.dev/router/introduction/)
- [AI SDK for Expo](https://ai-sdk.dev/docs/getting-started/expo)
- [NativeWind](https://www.nativewind.dev/)
- [Hugeicons React Native](https://hugeicons.com/)
