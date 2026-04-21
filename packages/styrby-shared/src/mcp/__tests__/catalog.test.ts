/**
 * Tests for the MCP tool catalog (mcp/catalog.ts).
 *
 * Validates structural integrity, uniqueness constraints, status lifecycle,
 * and semver format for all entries in STYRBY_MCP_TOOLS.
 *
 * WHY these tests: The catalog is consumed by the CLI (server registration),
 * web (registry browser), and mobile (settings mirror). Any drift in the
 * catalog — duplicate names, unknown categories, or malformed versions —
 * would cause silent mismatches between the UI and the runtime.
 *
 * @module mcp/__tests__/catalog
 */

import { describe, it, expect } from 'vitest';
import { STYRBY_MCP_TOOLS } from '../catalog.js';
import type { MCPToolDescriptor, MCPToolCategory, MCPToolStatus } from '../catalog.js';

// ============================================================================
// Catalog-level structural invariants
// ============================================================================

describe('STYRBY_MCP_TOOLS catalog', () => {
  it('is a non-empty readonly array', () => {
    expect(Array.isArray(STYRBY_MCP_TOOLS)).toBe(true);
    expect(STYRBY_MCP_TOOLS.length).toBeGreaterThan(0);
  });

  it('has unique tool names (no duplicates)', () => {
    const names = STYRBY_MCP_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every tool name is snake_case (MCP spec requirement)', () => {
    // WHY: MCP clients identify tools by name. Any non-snake_case name
    // breaks the CLI server registration and the webhook integration.
    const snakeCasePattern = /^[a-z][a-z0-9_]*$/;
    for (const tool of STYRBY_MCP_TOOLS) {
      expect(tool.name, `tool "${tool.name}" should be snake_case`).toMatch(snakeCasePattern);
    }
  });

  it('every tool has a non-empty title and description', () => {
    for (const tool of STYRBY_MCP_TOOLS) {
      expect(tool.title.length, `"${tool.name}" title should not be empty`).toBeGreaterThan(0);
      expect(tool.description.length, `"${tool.name}" description should not be empty`).toBeGreaterThan(0);
    }
  });

  it('every tool category is a valid MCPToolCategory', () => {
    const validCategories: MCPToolCategory[] = ['approval', 'policy', 'audit', 'query', 'mutation'];
    for (const tool of STYRBY_MCP_TOOLS) {
      expect(validCategories, `"${tool.name}" has unexpected category "${tool.category}"`).toContain(tool.category);
    }
  });

  it('every tool status is a valid MCPToolStatus', () => {
    const validStatuses: MCPToolStatus[] = ['ga', 'beta', 'planned'];
    for (const tool of STYRBY_MCP_TOOLS) {
      expect(validStatuses, `"${tool.name}" has unexpected status "${tool.status}"`).toContain(tool.status);
    }
  });

  it('every introducedIn follows loose semver format (major.minor.patch)', () => {
    // WHY: introducedIn drives the public roadmap display. Malformed versions
    // cause sort errors in the registry UI's version filter.
    const semverPattern = /^\d+\.\d+\.\d+$/;
    for (const tool of STYRBY_MCP_TOOLS) {
      expect(
        tool.introducedIn,
        `"${tool.name}" introducedIn "${tool.introducedIn}" should match major.minor.patch`
      ).toMatch(semverPattern);
    }
  });
});

// ============================================================================
// Individual known tools
// ============================================================================

describe('request_approval tool', () => {
  const tool = STYRBY_MCP_TOOLS.find((t) => t.name === 'request_approval');

  it('exists in the catalog', () => {
    expect(tool).toBeDefined();
  });

  it('is GA status (the only currently released tool)', () => {
    expect(tool?.status).toBe('ga');
  });

  it('has category: approval', () => {
    expect(tool?.category).toBe('approval');
  });

  it('was introduced in version 0.2.0', () => {
    expect(tool?.introducedIn).toBe('0.2.0');
  });
});

describe('planned tools', () => {
  const planned = STYRBY_MCP_TOOLS.filter((t) => t.status === 'planned');

  it('there are at least 2 planned tools on the roadmap', () => {
    expect(planned.length).toBeGreaterThanOrEqual(2);
  });

  it('planned tools are all scheduled for 0.4.0 or later', () => {
    for (const tool of planned) {
      const [, minor] = tool.introducedIn.split('.').map(Number);
      // 0.4.0+ => minor >= 4
      expect(minor, `planned tool "${tool.name}" should be >= 0.4.0`).toBeGreaterThanOrEqual(4);
    }
  });
});

// ============================================================================
// Shape conformance (every descriptor satisfies MCPToolDescriptor)
// ============================================================================

describe('MCPToolDescriptor shape conformance', () => {
  it('all tools satisfy the MCPToolDescriptor interface keys', () => {
    const requiredKeys: (keyof MCPToolDescriptor)[] = [
      'name',
      'title',
      'description',
      'category',
      'status',
      'introducedIn',
    ];

    for (const tool of STYRBY_MCP_TOOLS) {
      for (const key of requiredKeys) {
        expect(tool, `tool "${tool.name}" is missing key "${key}"`).toHaveProperty(key);
      }
    }
  });
});
