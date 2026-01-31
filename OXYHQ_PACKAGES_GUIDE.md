# OxyHQ Packages Usage Guide

This document explains which OxyHQ packages to use for each platform across all apps in this monorepo.

## Package Selection by Platform

### Web Apps (React, Next.js, Vite)
**Packages:** `@oxyhq/auth` + `@oxyhq/core`

**Apps using this:**
- ✅ `alia-providers-admin` - Vite + React admin panel
- ✅ `alia-console` - Vite + React console
- ✅ `canvas` - Next.js web app

**Usage:**
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

**Features:**
- FedCM (Federated Credential Management) support
- Cross-domain SSO
- Zero React Native dependencies
- Optimized for web browsers

---

### Expo / React Native Apps
**Packages:** `@oxyhq/services` + `@oxyhq/core`

**Apps using this:**
- ✅ `app` - Expo mobile app

**Usage:**
```typescript
import { OxyProvider, useAuth, useOxy } from '@oxyhq/services';

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </OxyProvider>
  );
}

function Component() {
  const { user, isAuthenticated, signIn, signOut } = useAuth();
  const { showBottomSheet, currentLanguage } = useOxy();
  // ...
}
```

**Features:**
- Native bottom sheet screens
- Secure keychain storage
- Cross-domain SSO (native)
- Account switching
- Multi-session support

---

### Backend / Node.js (Express, API servers)
**Packages:** `@oxyhq/core` only

**Apps using this:**
- ✅ `api` - Main Alia API server
- ✅ `alia-providers` - Providers microservice

**Usage:**
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

**Features:**
- Session validation
- User management
- Server-side API calls
- No UI dependencies

---

## Recent Fixes Applied

### 1. ✅ alia-providers-admin
**Issue:** README incorrectly claimed to use `@oxyhq/services/web`
**Fix:** Updated README to reflect actual usage of `@oxyhq/auth`
**Files changed:**
- `README.md` - Corrected architecture documentation

### 2. ✅ canvas
**Issue:** Using `@oxyhq/core` with custom auth implementation instead of `@oxyhq/auth`
**Fix:** Migrated to `@oxyhq/auth` with `WebOxyProvider`
**Files changed:**
- `package.json` - Added `@oxyhq/auth` dependency
- `lib/auth-context.tsx` - Replaced custom implementation with `WebOxyProvider` and `useAuth`

### 3. ✅ alia-console
**Status:** Already correctly using `@oxyhq/auth` + `@oxyhq/core`
**No changes needed**

### 4. ✅ app
**Status:** Already correctly using `@oxyhq/services` + `@oxyhq/core`
**No changes needed**

### 5. ✅ api
**Status:** Already correctly using `@oxyhq/core`
**No changes needed**

### 6. ✅ alia-providers
**Status:** Already correctly using `@oxyhq/core`
**No changes needed**

---

## Decision Tree: Which Package Should I Use?

```
Are you building...
├─ A web app (React, Next.js, Vite)?
│  └─ Use @oxyhq/auth + @oxyhq/core
│
├─ A mobile app (Expo, React Native)?
│  └─ Use @oxyhq/services + @oxyhq/core
│
└─ A backend (Node.js, Express)?
   └─ Use @oxyhq/core only
```

---

## Common Mistakes to Avoid

### ❌ Don't use `@oxyhq/services` in web apps
```typescript
// WRONG - for web apps
import { OxyProvider } from '@oxyhq/services';
```

### ✅ Instead use `@oxyhq/auth`
```typescript
// CORRECT - for web apps
import { WebOxyProvider } from '@oxyhq/auth';
```

---

### ❌ Don't use `@oxyhq/auth` in Expo/RN apps
```typescript
// WRONG - for mobile apps
import { WebOxyProvider } from '@oxyhq/auth';
```

### ✅ Instead use `@oxyhq/services`
```typescript
// CORRECT - for mobile apps
import { OxyProvider } from '@oxyhq/services';
```

---

### ❌ Don't use `@oxyhq/services` or `@oxyhq/auth` in backend
```typescript
// WRONG - for backend
import { WebOxyProvider } from '@oxyhq/auth';
```

### ✅ Instead use `@oxyhq/core` only
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

## Additional Documentation

- [GETTING_STARTED.md](apps/alia-providers-admin/GETTING_STARTED.md) - Comprehensive guide for all platforms
- [alia-providers-admin/README.md](apps/alia-providers-admin/README.md) - Web app example
- [CROSS_DOMAIN_AUTH.md](CROSS_DOMAIN_AUTH.md) - SSO deep dive (if available)

---

## Summary

All apps are now correctly configured:
- 3 web apps → `@oxyhq/auth` + `@oxyhq/core`
- 1 mobile app → `@oxyhq/services` + `@oxyhq/core`
- 2 backend services → `@oxyhq/core` only

Cross-domain SSO works automatically across all platforms! 🎉
