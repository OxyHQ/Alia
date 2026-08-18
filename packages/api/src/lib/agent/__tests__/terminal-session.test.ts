import { describe, expect, it, vi } from 'vitest';

vi.mock('../../sandbox/index.js', () => ({
  getSandboxProvider: vi.fn(),
}));

vi.mock('../../sandbox/container-pool.js', () => ({
  getContainerPool: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../../db/agents/containerRepository.js', () => ({
  createContainer: vi.fn(),
  idleContainer: vi.fn(),
  markContainerDestroyed: vi.fn(),
  ownedContainerIsAttachable: vi.fn(),
  resumeContainer: vi.fn(),
  touchContainer: vi.fn(),
}));

vi.mock('../workspace-memory.js', () => ({
  WorkspaceMemory: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  log: {
    agents: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

import {
  AGENT_ALLOWED_IMAGES,
  inferImage,
  normalizeAgentImage,
} from '../terminal-session.js';

describe('terminal-session image selection', () => {
  it('only infers images that the docker host allows', () => {
    const tasks = [
      ['build a Rust CLI with cargo', 'rust:1.77'],
      ['write a Go service', 'golang:1.22'],
      ['create a Rails app', 'ruby:3.3'],
      ['debug a Java Spring service', 'eclipse-temurin:21'],
      ['build a Next.js UI', 'node:20'],
      ['analyze a CSV with Python', 'python:3.12'],
    ] as const;

    for (const [task, image] of tasks) {
      expect(inferImage(task)).toBe(image);
      expect(AGENT_ALLOWED_IMAGES).toContain(inferImage(task));
    }
  });

  it('keeps valid preferred images', () => {
    expect(inferImage('build anything', 'node:22')).toBe('node:22');
    expect(normalizeAgentImage('ubuntu:24.04')).toBe('ubuntu:24.04');
  });

  it('falls back to the default image for invalid preferred images', () => {
    expect(inferImage('build anything', 'rust:latest')).toBe('python:3.12');
    expect(normalizeAgentImage('golang:latest')).toBe('python:3.12');
  });
});
