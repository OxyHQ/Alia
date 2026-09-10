import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('notification native boundary', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../use-notification-setup.ts'),
    'utf8',
  );

  it('does not evaluate expo-notifications at module load on web', () => {
    expect(source).not.toMatch(/import\s+.*from ['"]expo-notifications['"]/);
  });

  it('loads expo-notifications only after each web guard', () => {
    const guardedLoads = source.match(
      /if \(Platform\.OS === ['"]web['"]\) return;\s+const Notifications = require\(['"]expo-notifications['"]\)/g,
    );
    expect(guardedLoads).toHaveLength(3);
  });
});
