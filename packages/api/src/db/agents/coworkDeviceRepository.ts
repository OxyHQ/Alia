import { and, desc, eq, ne } from 'drizzle-orm';
import type { ApiDatabase } from '../index.js';
import { coworkDevices } from '../schema/agent-runtime.js';

export async function listCoworkDevices(db: ApiDatabase, oxyUserId: string) {
  return db.select().from(coworkDevices).where(eq(coworkDevices.oxyUserId, oxyUserId)).orderBy(desc(coworkDevices.lastSeenAt));
}

export async function registerCoworkDevice(db: ApiDatabase, input: {
  id: string; oxyUserId: string; name: string; platform: string; version: string; capabilities: Record<string, boolean>;
}) {
  const now = new Date();
  const [row] = await db.insert(coworkDevices).values({ ...input, status: 'online', lastSeenAt: now })
    .onConflictDoUpdate({
      target: coworkDevices.id,
      set: { name: input.name, platform: input.platform, version: input.version, capabilities: input.capabilities, status: 'online', lastSeenAt: now, updatedAt: now },
      setWhere: eq(coworkDevices.oxyUserId, input.oxyUserId),
    }).returning();
  return row;
}

export async function findOwnedCoworkDevice(db: ApiDatabase, oxyUserId: string, deviceId: string) {
  const [row] = await db.select().from(coworkDevices).where(and(
    eq(coworkDevices.id, deviceId), eq(coworkDevices.oxyUserId, oxyUserId),
  )).limit(1);
  return row;
}

export async function setCoworkDeviceStatus(db: ApiDatabase, oxyUserId: string, deviceId: string, status: 'online' | 'offline' | 'revoked') {
  const now = new Date();
  const [row] = await db.update(coworkDevices).set({ status, lastSeenAt: now, updatedAt: now }).where(and(
    eq(coworkDevices.id, deviceId), eq(coworkDevices.oxyUserId, oxyUserId),
    ...(status === 'online' ? [ne(coworkDevices.status, 'revoked')] : []),
  )).returning();
  return row;
}
