/**
 * The Agent Skills document format.
 *
 * Every path that accepts a skill — editor, zip upload, GitHub import, registry
 * sync, built-in seed — parses through `parseSkillDocument`, so what this file
 * pins down is the boundary of what Alia will store as a skill at all.
 */

import { describe, expect, it } from 'vitest';
import { SkillSpecError, parseSkillDocument, serializeSkillDocument } from '../spec.js';

const MINIMAL = `---
name: pdf-processing
description: Extracts text and tables from PDF files. Use when the user mentions PDFs or forms.
---

# PDF Processing

Use pdfplumber.
`;

describe('parseSkillDocument', () => {
  it('reads the two required fields and separates the body', () => {
    const doc = parseSkillDocument(MINIMAL);
    expect(doc.frontmatter.name).toBe('pdf-processing');
    expect(doc.frontmatter.description).toMatch(/^Extracts text/);
    expect(doc.body).toBe('# PDF Processing\n\nUse pdfplumber.');
    expect(doc.warnings).toEqual([]);
  });

  it('refuses a document with no frontmatter block', () => {
    expect(() => parseSkillDocument('# Just markdown')).toThrow(SkillSpecError);
  });

  it('refuses frontmatter that is not a mapping', () => {
    expect(() => parseSkillDocument('---\n- a\n- b\n---\nbody')).toThrow(/must be a YAML mapping/);
  });

  describe('name', () => {
    const withName = (name: string) => `---\nname: ${name}\ndescription: A skill. Use when testing.\n---\nbody`;

    it.each([
      ['PDF-Processing', 'uppercase'],
      ['-pdf', 'leading hyphen'],
      ['pdf-', 'trailing hyphen'],
      ['pdf--processing', 'consecutive hyphens'],
      ['pdf_processing', 'underscore'],
    ])('refuses %s (%s)', (name) => {
      expect(() => parseSkillDocument(withName(name))).toThrow(/name/);
    });

    it('refuses a name over 64 characters', () => {
      expect(() => parseSkillDocument(withName('a'.repeat(65)))).toThrow(/longer than 64/);
    });

    it('accepts a name of exactly 64 characters', () => {
      expect(parseSkillDocument(withName('a'.repeat(64))).frontmatter.name).toHaveLength(64);
    });

    it('refuses a reserved word only when the skill is authored here', () => {
      const source = withName('claude-helper');
      expect(() => parseSkillDocument(source, { authored: true })).toThrow(/reserved word/);
      expect(parseSkillDocument(source).frontmatter.name).toBe('claude-helper');
    });

    it('warns rather than throws when the name does not match its directory', () => {
      const doc = parseSkillDocument(MINIMAL, { directoryName: 'pdf-tools' });
      expect(doc.frontmatter.name).toBe('pdf-processing');
      expect(doc.warnings.join(' ')).toMatch(/does not match its directory/);
    });
  });

  describe('description', () => {
    it('refuses an empty description', () => {
      expect(() => parseSkillDocument('---\nname: a\ndescription: "  "\n---\nbody')).toThrow(/description/);
    });

    it('refuses a description over 1024 characters', () => {
      const long = 'x'.repeat(1025);
      expect(() => parseSkillDocument(`---\nname: a\ndescription: ${long}\n---\nbody`)).toThrow(/longer than 1024/);
    });

    it('refuses XML tags, which would reach the system prompt', () => {
      expect(() =>
        parseSkillDocument('---\nname: a\ndescription: "Does <thing>stuff</thing>"\n---\nbody'),
      ).toThrow(/XML tags/);
    });
  });

  describe('optional fields', () => {
    it('normalises allowed-tools from a space-separated string', () => {
      const doc = parseSkillDocument(
        '---\nname: a\ndescription: A skill. Use when testing.\nallowed-tools: "Bash(git:*) Read"\n---\nbody',
      );
      expect(doc.frontmatter.allowedTools).toEqual(['Bash(git:*)', 'Read']);
    });

    it('accepts a YAML list of allowed tools, which Claude Code writes', () => {
      const doc = parseSkillDocument(
        '---\nname: a\ndescription: A skill. Use when testing.\nallowed-tools:\n  - Read\n  - Grep\n---\nbody',
      );
      expect(doc.frontmatter.allowedTools).toEqual(['Read', 'Grep']);
    });

    it('refuses a compatibility string over 500 characters', () => {
      const long = 'x'.repeat(501);
      expect(() =>
        parseSkillDocument(`---\nname: a\ndescription: A skill. Use when testing.\ncompatibility: ${long}\n---\nbody`),
      ).toThrow(/compatibility/);
    });

    it('stringifies an unquoted metadata scalar and says so', () => {
      const doc = parseSkillDocument(
        '---\nname: a\ndescription: A skill. Use when testing.\nmetadata:\n  version: 1.0\n---\nbody',
      );
      expect(doc.frontmatter.metadata.version).toBe('1');
      expect(doc.warnings.join(' ')).toMatch(/metadata.version/);
    });

    it('refuses a nested metadata value', () => {
      expect(() =>
        parseSkillDocument('---\nname: a\ndescription: A skill. Use when testing.\nmetadata:\n  x:\n    y: z\n---\nbody'),
      ).toThrow(/metadata.x/);
    });
  });

  it('keeps an unknown key rather than rejecting the skill, and warns', () => {
    const doc = parseSkillDocument(
      '---\nname: a\ndescription: A skill. Use when testing.\ndisable-model-invocation: true\n---\nbody',
    );
    expect(doc.raw['disable-model-invocation']).toBe(true);
    expect(doc.warnings.join(' ')).toMatch(/disable-model-invocation/);
  });

  it('handles CRLF line endings, which a Windows-authored skill carries', () => {
    const doc = parseSkillDocument(MINIMAL.replace(/\n/g, '\r\n'));
    expect(doc.frontmatter.name).toBe('pdf-processing');
    expect(doc.body).toContain('# PDF Processing');
  });
});

describe('serializeSkillDocument', () => {
  it('round-trips through the parser', () => {
    const original = parseSkillDocument(
      '---\nname: a-skill\ndescription: "Does things: carefully. Use when testing."\nlicense: Apache-2.0\nallowed-tools: Read Grep\nmetadata:\n  author: oxy\n---\n\n# Body\n\ntext',
    );
    const round = parseSkillDocument(serializeSkillDocument(original.frontmatter, original.body));
    expect(round.frontmatter).toEqual(original.frontmatter);
    expect(round.body).toBe(original.body);
  });
});
