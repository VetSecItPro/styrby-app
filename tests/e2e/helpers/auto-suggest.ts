/**
 * Auto-Suggestion System
 * Logs fallback usage and generates testid suggestions
 */

import fs from 'fs';
import path from 'path';

interface TestIdSuggestion {
  timestamp: string;
  testId: string;
  context: any;
  priority: 'low' | 'medium' | 'high' | 'critical';
  suggestedFix: string;
  file?: string;
  line?: number;
  stackTrace?: string;
}

interface FallbackLog {
  timestamp: string;
  testId: string;
  strategyUsed: string;
  context: any;
  severity: 'INFO' | 'WARNING' | 'BRITTLE' | 'ERROR';
}

const SUGGESTIONS_DIR = path.join(process.cwd(), '.test-suggestions');
const SUGGESTIONS_FILE = path.join(SUGGESTIONS_DIR, 'suggestions.json');
const FALLBACK_LOG_FILE = path.join(SUGGESTIONS_DIR, 'fallback-usage.log');

/**
 * Ensure suggestions directory exists
 */
function ensureSuggestionsDir(): void {
  if (!fs.existsSync(SUGGESTIONS_DIR)) {
    fs.mkdirSync(SUGGESTIONS_DIR, { recursive: true });
  }
}

/**
 * Log fallback usage
 */
export async function logFallbackUsage(
  strategy: string,
  testId: string,
  context: any,
  severity: FallbackLog['severity'] = 'WARNING'
): Promise<void> {
  ensureSuggestionsDir();

  const log: FallbackLog = {
    timestamp: new Date().toISOString(),
    testId,
    strategyUsed: strategy,
    context,
    severity,
  };

  const logLine = `[${log.timestamp}] ${log.severity} - ${testId} - Used fallback: ${strategy} - ${JSON.stringify(context)}\n`;

  // Append to log file
  fs.appendFileSync(FALLBACK_LOG_FILE, logLine);

  // Also log to console in CI
  if (process.env.CI) {
    if (severity === 'BRITTLE' || severity === 'ERROR') {
      console.error(`⚠️  ${logLine.trim()}`);
    } else {
      console.warn(`ℹ️  ${logLine.trim()}`);
    }
  }
}

/**
 * Create testid suggestion
 */
export async function createTestIdSuggestion(
  testId: string,
  context: any,
  priority: TestIdSuggestion['priority'] = 'medium'
): Promise<void> {
  ensureSuggestionsDir();

  const suggestion: TestIdSuggestion = {
    timestamp: new Date().toISOString(),
    testId,
    context,
    priority,
    suggestedFix: generateSuggestedFix(testId, context),
    stackTrace: new Error().stack,
  };

  // Try to infer file and line from stack trace
  const location = inferLocationFromStack(suggestion.stackTrace);
  if (location) {
    suggestion.file = location.file;
    suggestion.line = location.line;
  }

  // Read existing suggestions
  let suggestions: TestIdSuggestion[] = [];
  if (fs.existsSync(SUGGESTIONS_FILE)) {
    try {
      suggestions = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf-8'));
    } catch (error) {
      suggestions = [];
    }
  }

  // Check if suggestion already exists (avoid duplicates)
  const exists = suggestions.some(
    (s) => s.testId === testId && s.priority === priority
  );

  if (!exists) {
    suggestions.push(suggestion);
    fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify(suggestions, null, 2));

    // Log to console
    console.warn(`💡 TestID Suggestion: Add data-testid="${testId}" to component`);

    // Create GitHub issue in CI if critical
    if (process.env.CI && priority === 'critical') {
      await createGitHubIssue(suggestion);
    }
  }
}

/**
 * Generate suggested fix based on context
 */
function generateSuggestedFix(testId: string, context: any): string {
  const { role, text, type, placeholder, customFallback } = context;

  if (customFallback) {
    return `Add data-testid="${testId}" to the component (custom fallback used)`;
  }

  let fix = `Add data-testid="${testId}"`;

  if (role === 'button') {
    fix += ' to <button> or <Button> component';
  } else if (role === 'link') {
    fix += ' to <Link> or <a> component';
  } else if (role === 'textbox') {
    if (type) {
      fix += ` to <input type="${type}">`;
    } else {
      fix += ' to <input> or <textarea>';
    }
  } else if (role === 'dialog') {
    fix += ' to <Modal> or <Dialog> component';
  } else if (role) {
    fix += ` to element with role="${role}"`;
  }

  if (text) {
    fix += `\nElement text: "${text}"`;
  }

  if (placeholder) {
    fix += `\nPlaceholder: "${placeholder}"`;
  }

  return fix;
}

/**
 * Infer file and line number from stack trace
 */
function inferLocationFromStack(stackTrace?: string): { file: string; line: number } | null {
  if (!stackTrace) return null;

  // Look for component file references in stack
  const lines = stackTrace.split('\n');

  for (const line of lines) {
    // Match patterns like: at /path/to/file.tsx:123:45
    const match = line.match(/at\s+(?:.*?\s+)?\(?([^:]+):(\d+):\d+\)?/);
    if (match) {
      const filePath = match[1];
      const lineNumber = parseInt(match[2], 10);

      // Only return component files (not test files or node_modules)
      if (
        (filePath.includes('components/') || filePath.includes('app/')) &&
        !filePath.includes('node_modules') &&
        !filePath.includes('tests/e2e')
      ) {
        return {
          file: filePath.replace(process.cwd(), '.'), // Make relative
          line: lineNumber,
        };
      }
    }
  }

  return null;
}

/**
 * Create GitHub issue for critical missing testids
 */
async function createGitHubIssue(suggestion: TestIdSuggestion): Promise<void> {
  // Only create issues in CI with GitHub token
  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠️  Cannot create GitHub issue: GITHUB_TOKEN not set');
    return;
  }

  const title = `[E2E] Missing testid: ${suggestion.testId}`;
  const body = `## Missing TestID

**Priority:** ${suggestion.priority}
**TestID:** \`${suggestion.testId}\`
**Context:** ${JSON.stringify(suggestion.context, null, 2)}

## Suggested Fix

\`\`\`tsx
${suggestion.suggestedFix}
\`\`\`

${suggestion.file ? `**File:** \`${suggestion.file}:${suggestion.line}\`` : ''}

## Why This Matters

The E2E test failed because this element lacks a \`data-testid\` attribute. Adding it will:
- ✅ Make tests more reliable (won't break when text changes)
- ✅ Improve test performance (testid lookups are faster)
- ✅ Prevent future test failures

## Automated Detection

This issue was automatically created by the E2E Intelligence System during test execution.

---

*🤖 Auto-generated by E2E Intelligence*
*Timestamp: ${suggestion.timestamp}*
`;

  try {
    // Use GitHub CLI to create issue
    const { execSync } = require('child_process');

    execSync(
      `gh issue create --title "${title}" --body "${body.replace(/"/g, '\\"')}" --label "e2e,testid,auto-generated,${suggestion.priority}"`,
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          GH_TOKEN: process.env.GITHUB_TOKEN,
        },
      }
    );

    console.log(`✅ Created GitHub issue for missing testid: ${suggestion.testId}`);
  } catch (error) {
    console.error('❌ Failed to create GitHub issue:', error);
  }
}

/**
 * Get all suggestions
 */
export function getAllSuggestions(): TestIdSuggestion[] {
  if (!fs.existsSync(SUGGESTIONS_FILE)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf-8'));
  } catch (error) {
    return [];
  }
}

/**
 * Get suggestions by priority
 */
export function getSuggestionsByPriority(
  priority: TestIdSuggestion['priority']
): TestIdSuggestion[] {
  return getAllSuggestions().filter((s) => s.priority === priority);
}

/**
 * Clear suggestions (for testing)
 */
export function clearSuggestions(): void {
  if (fs.existsSync(SUGGESTIONS_FILE)) {
    fs.unlinkSync(SUGGESTIONS_FILE);
  }
  if (fs.existsSync(FALLBACK_LOG_FILE)) {
    fs.unlinkSync(FALLBACK_LOG_FILE);
  }
}

/**
 * Generate summary report
 */
export function generateSummaryReport(): string {
  const suggestions = getAllSuggestions();

  if (suggestions.length === 0) {
    return '✅ No missing testids detected';
  }

  const critical = suggestions.filter((s) => s.priority === 'critical').length;
  const high = suggestions.filter((s) => s.priority === 'high').length;
  const medium = suggestions.filter((s) => s.priority === 'medium').length;
  const low = suggestions.filter((s) => s.priority === 'low').length;

  let report = '## Missing TestID Summary\n\n';
  report += `**Total:** ${suggestions.length}\n`;
  report += `- 🔴 Critical: ${critical}\n`;
  report += `- 🟠 High: ${high}\n`;
  report += `- 🟡 Medium: ${medium}\n`;
  report += `- 🟢 Low: ${low}\n\n`;

  // List critical and high priority items
  const urgent = suggestions.filter(
    (s) => s.priority === 'critical' || s.priority === 'high'
  );

  if (urgent.length > 0) {
    report += '### Urgent Items\n\n';
    urgent.forEach((s, i) => {
      report += `${i + 1}. **${s.testId}** (${s.priority})\n`;
      report += `   - ${s.suggestedFix}\n`;
      if (s.file) {
        report += `   - Location: \`${s.file}:${s.line}\`\n`;
      }
      report += '\n';
    });
  }

  return report;
}
