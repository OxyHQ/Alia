# Memory System Documentation

## Overview

The Alia AI memory system allows the AI to remember user preferences, personal information, goals, and experiences across conversations. This document covers the architecture, API endpoints, and recent improvements including export/import functionality.

## Table of Contents

- [Architecture](#architecture)
- [Data Model](#data-model)
- [Memory Limits by Plan](#memory-limits-by-plan)
- [API Endpoints](#api-endpoints)
- [AI Tools](#ai-tools)
- [Export/Import](#exportimport)
- [Frontend Integration](#frontend-integration)
- [Recent Bug Fixes](#recent-bug-fixes)

## Architecture

### Database Layer
- **Database**: MongoDB
- **Model**: `UserMemory` ([apps/api/src/models/user-memory.ts](apps/api/src/models/user-memory.ts))
- **Indexes**:
  - Text index on `memories.key` and `memories.value` for full-text search
  - Index on `memories.category` for filtering
  - Index on `memories.updatedAt` for sorting
  - Unique index on `oxyUserId` (one memory document per user)

### API Layer
- **Routes**: [apps/api/src/routes/memory.ts](apps/api/src/routes/memory.ts)
- **Authentication**: All endpoints require `authenticateToken` middleware
- **Validation**: Zod schemas in [apps/api/src/lib/validators/memory-validators.ts](apps/api/src/lib/validators/memory-validators.ts)

### AI Integration
- **Tools**: [apps/api/src/lib/tools/user-memory.ts](apps/api/src/lib/tools/user-memory.ts)
- **Automatic Saving**: AI automatically saves user preferences during conversations
- **Context Injection**: Memory is injected into system prompts for personalization

## Data Model

```typescript
interface IUserMemory {
  oxyUserId: ObjectId;              // Reference to Oxy user
  memories: Array<{
    key: string;                    // e.g., "favorite_color", "occupation"
    value: string;                  // e.g., "blue", "software engineer"
    category?: string;              // "preference", "personal", "goal", "experience"
    createdAt: Date;
    updatedAt: Date;
  }>;
  preferences: {
    language?: string;              // Preferred language
    tone?: string;                  // Communication tone (formal, casual)
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];           // Topics of interest
  };
  context: {
    occupation?: string;            // User's profession
    location?: string;              // Geographic location
    timezone?: string;              // User's timezone
    bio?: string;                   // User biography
  };
  createdAt: Date;
  updatedAt: Date;
}
```

## Memory Limits by Plan

| Plan | Memory Limit | Notes |
|------|--------------|-------|
| **Free** | 100 memories | Default for users without subscription |
| **Pro** | 1,000 memories | For Pro plan subscribers |
| **Business** | Unlimited | No memory limit |

### Implementation

The memory limit is determined by the user's subscription plan:

```typescript
export const getMemoryLimit = (planName?: string): number => {
  if (!planName) return MAX_MEMORIES_FREE; // 100

  const plan = planName.toLowerCase();
  if (plan.includes('business') || plan.includes('enterprise')) {
    return -1; // Unlimited
  }
  if (plan.includes('pro')) {
    return MAX_MEMORIES_PRO; // 1000
  }

  return MAX_MEMORIES_FREE; // 100
};
```

### Validation Limits

- **Key**: Max 200 characters, alphanumeric with underscores/hyphens
- **Value**: Max 10,000 characters
- **Category**: Max 50 characters

## API Endpoints

### Basic Operations

#### Get Memory Profile
```http
GET /api/memory
```

Returns the complete memory profile for the authenticated user.

**Response:**
```json
{
  "oxyUserId": "...",
  "memories": [...],
  "preferences": {...},
  "context": {...},
  "createdAt": "2024-01-24T00:00:00.000Z",
  "updatedAt": "2024-01-24T00:00:00.000Z"
}
```

#### Get Memory Statistics
```http
GET /api/memory/stats
```

**Response:**
```json
{
  "totalMemories": 42,
  "categories": {
    "preference": 10,
    "personal": 15,
    "goal": 8,
    "experience": 9
  },
  "hasPreferences": true,
  "hasContext": true
}
```

#### Add or Update Memory
```http
POST /api/memory/add
Content-Type: application/json

{
  "key": "favorite_color",
  "value": "blue",
  "category": "preference"
}
```

**Validation:**
- Key and value are required
- Checks memory limit based on user's plan
- Returns helpful upgrade suggestion if limit exceeded

**Response on Limit Exceeded (Free Plan):**
```json
{
  "error": "Memory limit exceeded",
  "limit": 100,
  "current": 100,
  "suggestion": "Upgrade to Pro or Business plan for more memories"
}
```

#### Update Specific Memory
```http
PUT /api/memory/:memoryId
Content-Type: application/json

{
  "key": "favorite_color",
  "value": "green",
  "category": "preference"
}
```

#### Delete Memory
```http
DELETE /api/memory/:memoryId
```

#### Update Preferences
```http
PUT /api/memory/preferences
Content-Type: application/json

{
  "language": "Spanish",
  "tone": "casual",
  "responseLength": "medium",
  "interests": ["AI", "programming", "music"]
}
```

#### Update Context
```http
PUT /api/memory/context
Content-Type: application/json

{
  "occupation": "Software Engineer",
  "location": "San Francisco, CA",
  "timezone": "America/Los_Angeles",
  "bio": "Full-stack developer passionate about AI"
}
```

### Search & Analysis

#### Search Memories
```http
GET /api/memory/search?q=color&category=preference&limit=50&offset=0&sortBy=updatedAt
```

**Query Parameters:**
- `q` (optional): Search query (searches key and value)
- `category` (optional): Filter by category
- `limit` (optional): Results per page (default: 50)
- `offset` (optional): Pagination offset (default: 0)
- `sortBy` (optional): Sort field - `updatedAt`, `createdAt`, or `key` (default: `updatedAt`)

**Response:**
```json
{
  "memories": [...],
  "total": 5,
  "limit": 50,
  "offset": 0
}
```

#### Find Duplicates
```http
GET /api/memory/duplicates
```

Detects potential duplicate memories based on:
- Identical values with different keys
- Similar keys (case-insensitive)

**Response:**
```json
{
  "duplicates": [
    {
      "memory1": {...},
      "memory2": {...},
      "reason": "identical_value"
    }
  ],
  "count": 1
}
```

### Export Functionality

#### Export Preview
```http
GET /api/memory/export/preview
```

Get statistics before exporting.

**Response:**
```json
{
  "totalMemories": 42,
  "totalCategories": 4,
  "categories": ["preference", "personal", "goal", "experience"],
  "hasPreferences": true,
  "hasContext": true,
  "estimatedSizeJSON": 8542,
  "estimatedSizeCSV": 4231,
  "oldestMemory": "2024-01-01T00:00:00.000Z",
  "newestMemory": "2024-01-24T00:00:00.000Z"
}
```

#### Export as JSON
```http
GET /api/memory/export/json
```

Downloads complete memory data including preferences and context.

**Response Headers:**
```
Content-Type: application/json
Content-Disposition: attachment; filename="alia-memories-1706054400000.json"
```

**Response Body:**
```json
{
  "version": "1.0",
  "exportedAt": "2024-01-24T00:00:00.000Z",
  "memories": [
    {
      "key": "favorite_color",
      "value": "blue",
      "category": "preference",
      "createdAt": "2024-01-20T00:00:00.000Z",
      "updatedAt": "2024-01-20T00:00:00.000Z"
    }
  ],
  "preferences": {
    "language": "Spanish",
    "tone": "casual"
  },
  "context": {
    "occupation": "Software Engineer"
  }
}
```

#### Export as CSV
```http
GET /api/memory/export/csv
```

Downloads memories only (excludes preferences and context) in CSV format.

**Response Headers:**
```
Content-Type: text/csv
Content-Disposition: attachment; filename="alia-memories-1706054400000.csv"
```

**Response Body:**
```csv
Key,Value,Category,Created At,Updated At
favorite_color,blue,preference,2024-01-20T00:00:00.000Z,2024-01-20T00:00:00.000Z
```

**CSV Features:**
- Proper escaping for commas, quotes, and newlines
- Compatible with Excel, Google Sheets, etc.
- All timestamps in ISO 8601 format

### Import Functionality

#### Validate Import
```http
POST /api/memory/import/validate
Content-Type: application/json

{
  "data": {
    "memories": [...],
    "preferences": {...},
    "context": {...}
  }
}
```

Validates import data without actually importing.

**Response (Valid):**
```json
{
  "valid": true,
  "analysis": {
    "totalToImport": 50,
    "duplicateKeys": 10,
    "newKeys": 40,
    "categories": ["preference", "personal"],
    "estimatedFinalTotal": 90,
    "memoryLimit": 100,
    "isUnlimited": false
  }
}
```

**Response (Invalid - Exceeds Limit):**
```json
{
  "valid": false,
  "errors": [
    {
      "message": "Import would exceed memory limit (150 > 100)"
    }
  ],
  "analysis": {...}
}
```

#### Import Memories
```http
POST /api/memory/import
Content-Type: application/json

{
  "data": {
    "memories": [...],
    "preferences": {...},
    "context": {...}
  },
  "strategy": "merge"
}
```

**Merge Strategies:**

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `merge` | Update existing by key, add new | **Recommended** - Safe default for updates |
| `skip-duplicates` | Only add new, skip existing | When you want to preserve existing values |
| `replace` | Delete all and replace | ⚠️ **Destructive** - Complete data replacement |

**Response:**
```json
{
  "success": true,
  "stats": {
    "imported": 40,
    "updated": 10,
    "skipped": 0,
    "errors": []
  },
  "totalMemories": 90
}
```

**Validation:**
- File size limit: 5MB
- Memory limit enforcement based on plan
- Comprehensive data structure validation
- No partial imports (atomic operation)

## AI Tools

### saveUserMemory

Automatically saves user information during conversations.

**When it triggers:**
- User shares preferences: "I like strawberries"
- User shares personal info: "My name is John"
- User shares goals: "I want to learn Spanish"
- User shares experiences: "I visited Paris last year"

**Parameters:**
```typescript
{
  key: string;      // Short identifier
  value: string;    // Memory content
  category?: string; // Optional: "preference", "personal", "goal", "experience"
}
```

**Behavior:**
- Updates existing memory if key matches
- Checks memory limit before adding new
- Returns helpful error if limit exceeded

### updateUserPreferences

Updates communication preferences.

**Parameters:**
```typescript
{
  language?: string;
  tone?: string;
  responseLength?: 'short' | 'medium' | 'long';
  interests?: string[];
}
```

### updateUserContext

Updates user context information.

**Parameters:**
```typescript
{
  occupation?: string;
  location?: string;
  timezone?: string;
  bio?: string;
}
```

## Export/Import

### Frontend Usage

#### Export Flow

1. User clicks "Export" button
2. Preview statistics are fetched (`GET /memory/export/preview`)
3. User selects format (JSON or CSV)
4. Download is triggered (`GET /memory/export/json` or `/csv`)
5. Browser downloads file with timestamped filename

**JSON Export includes:**
- All memories with metadata
- Preferences
- Context
- Export version and timestamp

**CSV Export includes:**
- Memories only
- Compatible with spreadsheets
- All timestamps in ISO format

#### Import Flow

1. User clicks "Import" button
2. User selects JSON file (max 5MB)
3. File is validated (`POST /memory/import/validate`)
4. Preview is shown:
   - Total memories to import
   - New vs duplicate count
   - Estimated final total
   - Memory limit check
5. User selects merge strategy
6. Import is executed (`POST /memory/import`)
7. Success message shows import stats
8. UI refreshes with new data

### Command Line Export Example

```bash
# Export as JSON
curl -H "x-session-id: YOUR_SESSION_ID" \
  https://api.yourserver.com/api/memory/export/json \
  -o memories.json

# Export as CSV
curl -H "x-session-id: YOUR_SESSION_ID" \
  https://api.yourserver.com/api/memory/export/csv \
  -o memories.csv
```

### Command Line Import Example

```bash
# Validate import first
curl -X POST https://api.yourserver.com/api/memory/import/validate \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d @memories.json

# Import with merge strategy
curl -X POST https://api.yourserver.com/api/memory/import \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "data": <contents of memories.json>,
    "strategy": "merge"
  }'
```

## Frontend Integration

### React Native Components

**Memory Settings Screen:** [apps/app/app/(app)/settings/memory.tsx](apps/app/app/(app)/settings/memory.tsx)

**Features:**
- Search and filter memories
- Add/Edit/Delete individual memories
- Category badges with icons
- Export dialog with format selection and statistics
- Import dialog with file picker, validation, and preview
- Merge strategy selector
- Real-time validation and error handling

### State Management

**Zustand Store:** [apps/app/lib/stores/user-data-store.ts](apps/app/lib/stores/user-data-store.ts)

**Features:**
- 5-minute cache duration
- AsyncStorage persistence
- Automatic refetch on cache expiry
- Manual refetch method

**Hook:** [apps/app/hooks/useUserData.ts](apps/app/hooks/useUserData.ts)

```typescript
const { memory, loading, refetch } = useUserData();
```

## Recent Bug Fixes

### Critical Bug Fix: Memory Not Saving

**Issue:** AI tools were unable to save memories during conversations.

**Root Cause:** Field name mismatch
- AI tools were querying with: `userId`
- Database schema expects: `oxyUserId`

**Fix:** Updated all AI tools ([apps/api/src/lib/tools/user-memory.ts](apps/api/src/lib/tools/user-memory.ts))
```typescript
// Before (broken)
let memory = await UserMemory.findOne({ userId });

// After (fixed)
let memory = await UserMemory.findOne({ oxyUserId });
```

**Impact:**
- Memory now saves correctly during conversations
- AI can remember user preferences and information
- All three tools fixed: `saveUserMemory`, `updateUserPreferences`, `updateUserContext`

### Performance Improvements

**Added MongoDB Indexes:**
```typescript
// Full-text search
UserMemorySchema.index({ 'memories.key': 'text', 'memories.value': 'text' });

// Category filtering
UserMemorySchema.index({ 'memories.category': 1 });

// Timestamp sorting
UserMemorySchema.index({ 'memories.updatedAt': -1 });
```

**Benefits:**
- Faster search queries
- Efficient category filtering
- Quick sorting by date

### New Features

1. **Plan-Based Memory Limits**
   - Free: 100 memories
   - Pro: 1,000 memories
   - Business: Unlimited

2. **Comprehensive Validation**
   - Zod schemas for all operations
   - Clear error messages
   - Runtime validation

3. **Export/Import System**
   - JSON and CSV export formats
   - Three merge strategies
   - Import validation and preview
   - File size limits (5MB)

4. **Search Enhancements**
   - Full-text search
   - Pagination support
   - Multiple sort options
   - Category filtering

5. **Duplicate Detection**
   - Identifies identical values
   - Detects similar keys
   - Helps maintain data quality

## Error Handling

### Common Errors

**Memory Limit Exceeded:**
```json
{
  "error": "Memory limit exceeded",
  "limit": 100,
  "current": 100,
  "suggestion": "Upgrade to Pro or Business plan for more memories"
}
```

**Invalid Memory Data:**
```json
{
  "error": "Invalid memory data",
  "details": [
    {
      "path": "key",
      "message": "Key must be alphanumeric with underscores or hyphens only"
    }
  ]
}
```

**Import File Too Large:**
```json
{
  "error": "Import data too large",
  "maxSize": 5242880,
  "actualSize": 6000000
}
```

**Import Would Exceed Limit:**
```json
{
  "error": "Import would exceed memory limit (150 > 100)"
}
```

## Best Practices

### For Developers

1. **Always validate input** using the provided Zod schemas
2. **Check memory limits** before adding new memories
3. **Use atomic operations** for imports (no partial updates)
4. **Provide clear error messages** with actionable suggestions
5. **Use indexes** for search and filtering operations
6. **Test with large datasets** (1000+ memories)

### For Users

1. **Export regularly** as backup
2. **Use merge strategy** for safe imports
3. **Clean up duplicates** periodically
4. **Organize with categories** for better filtering
5. **Monitor memory usage** via stats endpoint
6. **Upgrade plan** when nearing limits

## Deployment Notes

### Environment Variables

Required for Telegram bot integration:
```bash
TELEGRAM_BOT_SECRET=<your-secure-random-string>
```

Generate with:
```bash
openssl rand -hex 32
```

### Database Migration

The MongoDB indexes are created automatically on first connection. No manual migration needed.

### Testing Checklist

- [ ] Memory saves during AI conversation
- [ ] Export JSON works and downloads
- [ ] Export CSV works and downloads
- [ ] Import validation catches errors
- [ ] Import merge strategy works correctly
- [ ] Memory limit enforcement works
- [ ] Search and pagination work
- [ ] Duplicate detection works
- [ ] Frontend UI handles all states

## Support

For issues or questions:
- GitHub Issues: https://github.com/anthropics/alia-ai/issues
- Documentation: This file
- API Reference: See [API Endpoints](#api-endpoints) section

---

**Last Updated:** January 24, 2024
**Version:** 1.0.0
