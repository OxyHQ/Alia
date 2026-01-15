# Authentication Setup

This project uses JWT-based authentication with all auth logic handled server-side. Passwords are securely hashed using bcrypt, and JWTs are validated on all protected API calls.

## Architecture

### Backend (Express + MongoDB)

- **Password Hashing**: Uses `bcryptjs` with salt rounds of 10
- **JWT Tokens**: Signed with `jsonwebtoken`, expires in 7 days by default
- **Middleware**: Authentication middleware validates Bearer tokens on protected routes
- **Database**: MongoDB with Mongoose models

### Frontend (Expo React Native)

- **Token Storage**: Tokens stored securely in AsyncStorage via Zustand persist
- **Auto-Injection**: Axios interceptor automatically adds Bearer token to requests
- **Route Protection**: Protected routes redirect to login if not authenticated
- **Auth Session**: Uses `expo-auth-session` for OAuth flows (future enhancement)

## Setup

### 1. Backend Configuration

Create a `.env` file in `apps/api/`:

```env
# Required
MONGODB_URI=mongodb://localhost:27017/alia
JWT_SECRET=your-super-secret-key-min-32-chars-change-in-production
JWT_EXPIRES_IN=7d

# Optional
API_PORT=3001
NODE_ENV=development
```

**Important**: Use a strong, random secret for `JWT_SECRET` in production!

### 2. Install Dependencies

Dependencies are already installed:
- Backend: `jsonwebtoken`, `@types/jsonwebtoken`, `bcryptjs`, `@types/bcryptjs`
- Frontend: `expo-auth-session`, `@react-native-async-storage/async-storage`, `zustand`

### 3. Start the Services

```bash
# Start API server
cd apps/api
npm run dev

# Start Expo app (in another terminal)
cd apps/app
npm run dev
```

## API Endpoints

### Public Endpoints

#### POST `/api/auth/register`
Register a new user.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword123",
  "firstName": "John",
  "lastName": "Doe"  // optional
}
```

**Response:**
```json
{
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Validation:**
- Email must be valid format
- Password must be at least 8 characters
- First name is required

#### POST `/api/auth/login`
Login with email and password.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

**Response:**
```json
{
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Errors:**
- `401`: Invalid email or password
- `400`: Validation error

### Protected Endpoints

All protected endpoints require a valid JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

#### GET `/api/auth/me`
Get current authenticated user information.

**Response:**
```json
{
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "John Doe",
    "image": "https://..."
  }
}
```

#### POST `/api/auth/logout`
Logout current user (client-side token removal).

**Response:**
```json
{
  "message": "Logged out successfully"
}
```

## Security Features

### Server-Side

1. **Password Hashing**: Passwords never stored in plain text
   - Uses bcrypt with 10 salt rounds
   - Hash happens automatically via Mongoose pre-save hook

2. **JWT Validation**: All protected routes validate tokens
   - Token signature verified
   - Expiration checked
   - User existence verified in database

3. **Input Validation**: All inputs validated with Zod schemas
   - Email format validation
   - Password strength requirements
   - XSS protection via input sanitization

### Client-Side

1. **Secure Storage**: Tokens stored in AsyncStorage (encrypted on device)
   - Uses Zustand persist middleware
   - Automatically cleared on logout

2. **Auto Token Injection**: Axios interceptor adds Bearer token
   - See [apps/app/lib/api/client.ts](apps/app/lib/api/client.ts#L14-L25)

3. **Auto Logout on 401**: Invalid/expired tokens trigger logout
   - See [apps/app/lib/api/client.ts](apps/app/lib/api/client.ts#L28-L36)

4. **Route Protection**: Unauthenticated users redirected to login
   - See [apps/app/app/(chat)/_layout.tsx](apps/app/app/(chat)/_layout.tsx#L13-L16)

## Protecting API Routes

To protect an API route with authentication:

```typescript
import { authenticateToken } from '../middleware/auth.js';

// Add middleware to route
router.get('/protected-route', authenticateToken, async (req, res) => {
  // Access authenticated user via req.user
  const userId = req.user?.id;
  const userEmail = req.user?.email;

  // Your protected logic here
});
```

For optional authentication (works both authenticated and unauthenticated):

```typescript
import { optionalAuth } from '../middleware/auth.js';

router.get('/public-route', optionalAuth, async (req, res) => {
  if (req.user) {
    // User is authenticated
  } else {
    // User is not authenticated
  }
});
```

## Frontend Usage

### Login Example

```typescript
import apiClient from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';

const { login } = useAuthStore();

try {
  const response = await apiClient.post('/auth/login', {
    email: 'user@example.com',
    password: 'password123',
  });

  const { user, token } = response.data;
  login(user, token); // Stores in AsyncStorage

  // Navigate to protected route
  router.push('/(chat)');
} catch (error) {
  console.error(error.response?.data?.error);
}
```

### Making Authenticated Requests

```typescript
import apiClient from '@/lib/api/client';

// Token is automatically added to Authorization header
const response = await apiClient.get('/api/conversations');
```

### Logout

```typescript
import { useAuthStore } from '@/lib/stores/auth-store';

const { logout } = useAuthStore();

// Clear token and user data
logout();

// Redirect to login
router.push('/login');
```

### Accessing Current User

```typescript
import { useAuthStore } from '@/lib/stores/auth-store';

function MyComponent() {
  const { user, isAuthenticated } = useAuthStore();

  if (isAuthenticated) {
    console.log(`Hello, ${user.name}!`);
  }
}
```

## Password Reset Flow (TODO)

The password reset endpoints are placeholders and need implementation:
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`

Recommended flow:
1. User requests reset with email
2. Generate secure token, store in database with expiration
3. Send email with reset link containing token
4. Verify token and update password
5. Invalidate reset token after use

## Future Enhancements

1. **OAuth Integration**: Use `expo-auth-session` for Google/Apple sign-in
2. **Token Refresh**: Implement refresh tokens for better security
3. **Token Blacklist**: Track invalidated tokens (logout, password change)
4. **Rate Limiting**: Add rate limiting to prevent brute force attacks
5. **2FA**: Add two-factor authentication option
6. **Session Management**: Track active sessions, allow remote logout

## Testing

### Manual Testing

1. **Register**: Create a new account in the app
2. **Login**: Login with credentials
3. **Protected Route**: Try accessing chat (should work)
4. **Logout**: Logout and try accessing chat (should redirect to login)
5. **Invalid Token**: Manually corrupt token in AsyncStorage and make API call (should auto-logout)

### API Testing with curl

```bash
# Register
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test12345","firstName":"Test","lastName":"User"}'

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test12345"}'

# Get current user (replace TOKEN with actual token)
curl http://localhost:3001/api/auth/me \
  -H "Authorization: Bearer TOKEN"
```

## Troubleshooting

### "Invalid or expired token"
- Token may have expired (default 7 days)
- Token signature invalid (JWT_SECRET changed)
- User deleted from database
- **Solution**: Logout and login again

### "User already exists"
- Email already registered
- **Solution**: Use different email or login instead

### Unauthorized errors
- Token not being sent with request
- Check axios interceptor is working
- Verify token exists in AsyncStorage
- **Solution**: Check [apps/app/lib/api/client.ts](apps/app/lib/api/client.ts)

### CORS errors
- API not accepting requests from app
- Check `WEB_URL` in backend `.env`
- **Solution**: Add your app's origin to CORS config

## File Structure

```
apps/
├── api/
│   ├── src/
│   │   ├── lib/
│   │   │   └── jwt.ts              # JWT sign/verify utilities
│   │   ├── middleware/
│   │   │   └── auth.ts             # Authentication middleware
│   │   ├── models/
│   │   │   └── user.ts             # User model with password hashing
│   │   └── routes/
│   │       └── auth.ts             # Auth endpoints (login, register, etc.)
│   └── .env.example
│
└── app/
    ├── app/
    │   ├── (chat)/
    │   │   └── _layout.tsx         # Protected route wrapper
    │   ├── login.tsx               # Login screen
    │   ├── register.tsx            # Register screen
    │   └── index.tsx               # Root redirect logic
    └── lib/
        ├── api/
        │   └── client.ts           # Axios client with interceptors
        └── stores/
            └── auth-store.ts       # Zustand auth state management
```
