# OxyHQ Authentication & Packages Guide

This document explains which OxyHQ packages to use for each platform and provides detailed code examples for integration.

## Decision Tree: Which Package Should I Use?

```
Are you building...
|-- A web app (React, Next.js, Vite)?
|   -> Use @oxyhq/auth + @oxyhq/core
|
|-- A mobile app (Expo, React Native)?
|   -> Use @oxyhq/services + @oxyhq/core
|
|-- A backend (Node.js, Express)?
    -> Use @oxyhq/core only
```

---

## Package Selection by Platform

### Web Apps (React, Next.js, Vite)

**Packages:** `@oxyhq/auth` + `@oxyhq/core`

**Apps using this:**
- `alia-gateway-admin` - Vite + React admin panel
- `alia-console` - Vite + React console
- `canvas` - Next.js web app

**Features:**
- FedCM (Federated Credential Management) support
- Cross-domain SSO
- Zero React Native dependencies
- Optimized for web browsers

### Expo / React Native Apps

**Packages:** `@oxyhq/services` + `@oxyhq/core`

**Apps using this:**
- `app` - Expo mobile app

**Features:**
- Native bottom sheet screens
- Secure keychain storage
- Cross-domain SSO (native)
- Account switching
- Multi-session support

### Backend / Node.js (Express, API servers)

**Packages:** `@oxyhq/core` only

**Apps using this:**
- `api` - Main Alia API server (includes internal providers module)

**Features:**
- Session validation
- User management
- Server-side API calls
- No UI dependencies

---

## Native Apps (React Native / Expo)

### Installation

```bash
npm install @oxyhq/services @oxyhq/core
```

#### Peer Dependencies

```bash
npm install react-native-reanimated react-native-gesture-handler \
  react-native-safe-area-context react-native-svg \
  expo expo-font expo-image expo-linear-gradient \
  @react-navigation/native @tanstack/react-query
```

### Setup Entry Point

Add polyfill at the very top of your entry file:

```javascript
// index.js or App.js (first line)
import 'react-native-url-polyfill/auto';
```

### Wrap with Provider

```tsx
import { OxyProvider } from '@oxyhq/services';

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </OxyProvider>
  );
}
```

`OxyProvider` works on iOS, Android, and Expo web. Always use `OxyProvider` in Expo apps.

### Use Authentication

```tsx
import { useAuth, OxySignInButton } from '@oxyhq/services';

function HomeScreen() {
  const { user, isAuthenticated, isLoading, signOut } = useAuth();

  if (isLoading) return <Loading />;

  if (!isAuthenticated) {
    return (
      <View>
        <Text>Please sign in</Text>
        <OxySignInButton />
      </View>
    );
  }

  return (
    <View>
      <Text>Welcome, {user?.username}!</Text>
      <Button title="Sign Out" onPress={signOut} />
    </View>
  );
}
```

Cross-domain SSO is automatic. If a user is signed in on any Oxy domain (accounts.oxy.so, mention.earth, homiio.com, etc.), they are automatically signed in on your app.

### Full Expo Example

```tsx
// app/_layout.tsx
import 'react-native-url-polyfill/auto';
import { OxyProvider } from '@oxyhq/services';
import * as Linking from 'expo-linking';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

export default function RootLayout() {
  return (
    <OxyProvider
      baseURL={API_URL}
      authRedirectUri={Linking.createURL('/')}
    >
      <YourApp />
    </OxyProvider>
  );
}
```

### Bottom Sheet Screens

```tsx
import { useOxy } from '@oxyhq/services';

const { showBottomSheet } = useOxy();

// Account
showBottomSheet('AccountCenter');      // Main account hub
showBottomSheet('AccountSwitcher');    // Switch accounts
showBottomSheet('SessionManagement');  // Manage devices
showBottomSheet('AccountSettings');    // Edit profile

// Auth
showBottomSheet('OxyAuth');            // QR code auth

// Features
showBottomSheet('FileManagement');     // Files
showBottomSheet('LanguageSelector');   // Language
showBottomSheet('KarmaCenter');        // Karma

// Payments
showBottomSheet({ screen: 'PaymentGateway', props: { amount: 10 } });
```

### useAuth Hook Reference

```tsx
import { useAuth } from '@oxyhq/services';

const {
  // State
  user,              // User | null - current user
  isAuthenticated,   // boolean - is user signed in
  isLoading,         // boolean - initial auth check
  isReady,           // boolean - ready for API calls
  error,             // string | null - error message

  // Actions
  signIn,            // () => Promise<User> - trigger sign in
  signOut,           // () => Promise<void> - sign out current session
  signOutAll,        // () => Promise<void> - sign out all devices
  refresh,           // () => Promise<void> - refresh auth state

  // Advanced
  oxyServices,       // OxyServices instance
} = useAuth();
```

### Advanced: useOxy Hook

For full control in Expo/RN apps, use `useOxy` instead of `useAuth`:

```tsx
import { useOxy } from '@oxyhq/services';

const {
  // All useAuth properties plus:
  sessions,            // All active sessions
  activeSessionId,     // Current session ID
  switchSession,       // Switch between accounts
  refreshSessions,     // Refresh session list

  // Language
  currentLanguage,     // 'en', 'es', etc.
  setLanguage,         // Change language

  // UI
  showBottomSheet,     // Show bottom sheet screens
  openAvatarPicker,    // Open avatar picker

  // Identity
  hasIdentity,         // Check for crypto identity
  getPublicKey,        // Get public key
} = useOxy();
```

---

## Web Apps (Next.js / React)

### Installation

```bash
npm install @oxyhq/auth @oxyhq/core
```

### Next.js Example

```tsx
// app/providers.tsx
'use client';
import { WebOxyProvider } from '@oxyhq/auth';

export function Providers({ children }) {
  return (
    <WebOxyProvider baseURL="https://api.oxy.so">
      {children}
    </WebOxyProvider>
  );
}

// app/layout.tsx
import { Providers } from './providers';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

// app/page.tsx
'use client';
import { useAuth } from '@oxyhq/auth';

export default function Home() {
  const { user, isAuthenticated, isLoading, signIn } = useAuth();

  if (isLoading) return <div>Loading...</div>;

  return isAuthenticated ? (
    <h1>Welcome, {user?.username}!</h1>
  ) : (
    <button onClick={() => signIn()}>Sign In</button>
  );
}
```

### Vite + React Example

```typescript
import { WebOxyProvider, useAuth } from '@oxyhq/auth';

export function App() {
  return (
    <WebOxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </WebOxyProvider>
  );
}

function Component() {
  const { user, isAuthenticated, signIn, signOut } = useAuth();
  // ...
}
```

### How Web SSO Works

Cross-domain SSO uses **FedCM** (Federated Credential Management) -- the browser-native identity API that works without third-party cookies.

1. User signs in on `auth.oxy.so` (or any Oxy app)
2. Browser stores FedCM credential
3. Your app's provider uses FedCM to request identity
4. Browser returns ID token instantly (no network request to IdP)
5. Your app exchanges token for session

**Browser Support:** Chrome 108+, Safari 16.4+, Edge 108+. For Firefox and older browsers, users click "Sign In" which opens a popup.

---

## Backend (Node.js / Express / Next.js API)

### Installation

```bash
npm install @oxyhq/core
```

### Quick Start

```typescript
import { OxyServices } from '@oxyhq/core';

const oxyClient = new OxyServices({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so'
});

// Validate sessions
const { valid, user } = await oxyClient.validateSession(sessionId);

// Get user data
const user = await oxyClient.getCurrentUser();
const profile = await oxyClient.getUserByUsername('nate');
```

### Express Middleware

```typescript
import { oxyClient } from '@oxyhq/core';

async function authMiddleware(req, res, next) {
  const sessionId = req.headers['x-session-id'] || req.cookies.sessionId;

  if (!sessionId) {
    return res.status(401).json({ error: 'No session' });
  }

  try {
    const { valid, user } = await oxyClient.validateSession(sessionId);
    if (!valid) return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Auth failed' });
  }
}

app.get('/api/me', authMiddleware, (req, res) => res.json(req.user));
```

### Next.js API Route

```typescript
// app/api/user/[id]/route.ts
import { oxyClient } from '@oxyhq/core';
import { NextResponse } from 'next/server';

export async function GET(req, { params }) {
  try {
    const user = await oxyClient.getUserById(params.id);
    return NextResponse.json(user);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
```

### Available Methods

```typescript
// Users
await oxyClient.getUserById(id);
await oxyClient.getUserByUsername(username);
await oxyClient.getProfileByUsername(username);
await oxyClient.getCurrentUser();

// Sessions
await oxyClient.validateSession(sessionId);
await oxyClient.logoutSession(sessionId);

// Social
await oxyClient.getUserFollowers(userId);
await oxyClient.getUserFollowing(userId);
await oxyClient.followUser(userId);
await oxyClient.unfollowUser(userId);

// Karma
await oxyClient.getKarma();
await oxyClient.getKarmaLeaderboard();

// Wallet
await oxyClient.getWallet();
await oxyClient.transferFunds(request);

// Files
await oxyClient.listFiles();
await oxyClient.uploadFile(file);
await oxyClient.deleteFile(fileId);
```

---

## Common Mistakes to Avoid

### Don't use `@oxyhq/services` in web apps

```typescript
// WRONG - for web apps
import { OxyProvider } from '@oxyhq/services';
```

Instead use `@oxyhq/auth`:

```typescript
// CORRECT - for web apps
import { WebOxyProvider } from '@oxyhq/auth';
```

### Don't use `@oxyhq/auth` in Expo/RN apps

```typescript
// WRONG - for mobile apps
import { WebOxyProvider } from '@oxyhq/auth';
```

Instead use `@oxyhq/services`:

```typescript
// CORRECT - for mobile apps
import { OxyProvider } from '@oxyhq/services';
```

### Don't use `@oxyhq/services` or `@oxyhq/auth` in backend

```typescript
// WRONG - for backend
import { WebOxyProvider } from '@oxyhq/auth';
```

Instead use `@oxyhq/core` only:

```typescript
// CORRECT - for backend
import { OxyServices } from '@oxyhq/core';
```

---

## Environment Variables

### Web Apps

```env
# React/Next.js/Vite
VITE_API_URL=https://api.oxy.so
# or
NEXT_PUBLIC_API_URL=https://api.oxy.so
```

### Mobile Apps

```env
# Expo
EXPO_PUBLIC_API_URL=https://api.oxy.so
```

### Backend

```env
# Node.js
OXY_API_URL=https://api.oxy.so
```

---

## Troubleshooting

### "useAuth/useOxy must be used within OxyProvider"

Wrap your app with `<OxyProvider>` (Expo/RN) or `<WebOxyProvider>` from `@oxyhq/auth` (web).

### SSO not working on web

1. Ensure you are using HTTPS (required for FedCM)
2. Check browser version: Chrome 108+, Safari 16.4+, Edge 108+
3. For Firefox: FedCM not supported, users must click "Sign In" (uses popup)
4. Verify FedCM config: `https://auth.oxy.so/fedcm.json`

### Native keychain issues

1. iOS: Enable "Keychain Sharing" in Xcode with group `group.so.oxy.shared`
2. Android: Add `android:sharedUserId="so.oxy.shared"` to manifest
3. Both: Apps must be signed with same certificate/team

---

## Summary

All apps in this monorepo are configured as follows:
- 3 web apps use `@oxyhq/auth` + `@oxyhq/core`
- 1 mobile app uses `@oxyhq/services` + `@oxyhq/core`
- 1 backend service uses `@oxyhq/core` only

Cross-domain SSO works automatically across all platforms.
