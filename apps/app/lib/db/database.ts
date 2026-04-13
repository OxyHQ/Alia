import { createContext, createElement, useContext, useState, type ReactNode } from 'react';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { runMigrations } from './migrations';

const DB_NAME = 'alia.db';

let dbInstance: SQLiteDatabase | null = null;

/**
 * Open (or return the existing) singleton SQLiteDatabase.
 * Enables WAL journal mode and foreign keys on first open.
 */
export function getDatabase(): SQLiteDatabase {
  if (dbInstance) return dbInstance;

  const db = openDatabaseSync(DB_NAME);
  db.execSync('PRAGMA journal_mode = WAL');
  db.execSync('PRAGMA foreign_keys = ON');

  dbInstance = db;
  return db;
}

const DatabaseContext = createContext<SQLiteDatabase | null>(null);

interface DatabaseProviderProps {
  children: ReactNode;
}

/**
 * Initializes the SQLite database, runs migrations, and provides the
 * database instance to descendants via React context.
 *
 * Blocks rendering (returns null) until initialization is complete.
 */
export function DatabaseProvider({ children }: DatabaseProviderProps): ReactNode {
  // useState with an initializer runs once synchronously on first render,
  // guaranteeing the DB + migrations are ready before children mount.
  const [db] = useState<SQLiteDatabase>(() => {
    const database = getDatabase();
    runMigrations(database);
    return database;
  });

  return createElement(DatabaseContext.Provider, { value: db }, children);
}

/**
 * Retrieve the SQLiteDatabase from the nearest DatabaseProvider.
 * Throws if called outside of a DatabaseProvider.
 */
export function useDatabase(): SQLiteDatabase {
  const db = useContext(DatabaseContext);
  if (db === null) {
    throw new Error('useDatabase must be used within a <DatabaseProvider>');
  }
  return db;
}
