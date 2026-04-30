/**
 * Template Command Handler
 *
 * Manages context templates stored in Supabase. Templates allow users to define
 * reusable project context that can be injected into agent sessions with
 * variable substitution.
 *
 * Subcommands:
 * - list: List all user templates
 * - create <name>: Create a new template (prompts for description, content)
 * - show <name>: Display template details
 * - use <name>: Output rendered template content
 * - delete <name>: Delete with confirmation
 *
 * @module commands/template
 */

import chalk from 'chalk';
import { logger } from '@/ui/logger';
import { confirm, prompt } from '@/ui/interactive';
import { getApiClient, MissingStyrbyKeyError } from '@/api/clientFromPersistence';
import { StyrbyApiError, type StyrbyApiClient, type TemplateRow, type TemplateSummary } from '@/api/styrbyApiClient';
import {
  ContextTemplate,
  ContextTemplateRow,
  contextTemplateFromRow,
  renderContextTemplate,
  extractVariableNames,
  ContextTemplateVariable,
} from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of template operations
 */
interface TemplateResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Handle the `styrby template` command.
 *
 * Routes to the appropriate subcommand handler based on the first argument.
 *
 * @param args - Command arguments [subcommand, ...rest]
 * @returns Promise that resolves when the command completes
 *
 * @example
 * // Called from index.ts
 * case 'template':
 *   await handleTemplate(args.slice(1));
 *   break;
 */
export async function handleTemplate(args: string[]): Promise<void> {
  const subCommand = args[0];

  switch (subCommand) {
    case 'list':
    case 'ls':
      await handleTemplateList();
      break;

    case 'create':
    case 'new':
    case 'add':
      await handleTemplateCreate(args.slice(1));
      break;

    case 'show':
    case 'view':
    case 'get':
      await handleTemplateShow(args.slice(1));
      break;

    case 'use':
    case 'apply':
    case 'render':
      await handleTemplateUse(args.slice(1));
      break;

    case 'delete':
    case 'rm':
    case 'remove':
      await handleTemplateDelete(args.slice(1));
      break;

    default:
      printTemplateUsage();
      break;
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

/**
 * Handle `styrby template list` - List all user templates.
 *
 * Displays a formatted table of all templates owned by the current user,
 * including name, description, variable count, and default status.
 *
 * @returns Promise that resolves when list is displayed
 */
async function handleTemplateList(): Promise<void> {
  const apiClient = ensureApiClientOrExit();

  console.log(chalk.gray('\nFetching templates...\n'));

  let result: Awaited<ReturnType<StyrbyApiClient['listTemplates']>>;
  try {
    result = await apiClient.listTemplates();
  } catch (err) {
    handleApiError(err, 'fetch templates');
    return; // unreachable; handleApiError exits
  }

  if (result.count === 0) {
    console.log(chalk.yellow('No templates found.'));
    console.log(chalk.gray('\nCreate one with: styrby template create <name>'));
    return;
  }

  // WHY transform via row → domain: existing renderContextTemplate / display
  // helpers all consume the ContextTemplate domain shape, not the row shape.
  // The /api/v1/templates list returns the same DB columns as the prior direct
  // .from('context_templates').select('*') — drop in the transform unchanged.
  const templates = (result.templates as unknown as ContextTemplateRow[]).map(contextTemplateFromRow);

  // Display header
  console.log(chalk.bold('Your Templates'));
  console.log(chalk.gray('─'.repeat(60)));

  // Display each template
  for (const template of templates) {
    const defaultBadge = template.isDefault ? chalk.cyan(' [default]') : '';
    const varCount = template.variables.length;
    const varLabel = varCount > 0 ? chalk.gray(` (${varCount} variables)`) : '';

    console.log('');
    console.log(chalk.white.bold(`  ${template.name}`) + defaultBadge + varLabel);

    if (template.description) {
      console.log(chalk.gray(`    ${template.description}`));
    }
  }

  console.log('');
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.gray(`Total: ${templates.length} template${templates.length === 1 ? '' : 's'}`));
  console.log('');
}

/**
 * Handle `styrby template create <name>` - Create a new template.
 *
 * Prompts the user for description and content, then creates the template
 * in Supabase. Automatically extracts variables from the content.
 *
 * @param args - Command arguments [name]
 * @returns Promise that resolves when template is created
 */
async function handleTemplateCreate(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    console.log(chalk.red('\nTemplate name is required.'));
    console.log(chalk.gray('Usage: styrby template create <name>'));
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  console.log('');
  console.log(chalk.bold(`Create Template: ${name}`));
  console.log(chalk.gray('─'.repeat(40)));
  console.log('');

  // Prompt for description
  const description = await prompt('Description (optional)');

  // Prompt for content
  console.log('');
  console.log(chalk.gray('  Enter template content. Use {{variable_name}} for placeholders.'));
  console.log(chalk.gray('  Press Enter twice when done.'));
  console.log('');

  const content = await promptMultiline('  Content: ');

  if (!content.trim()) {
    console.log(chalk.red('\nTemplate content cannot be empty.'));
    process.exit(1);
  }

  // Extract variables from content
  const variableNames = extractVariableNames(content);
  const variables: ContextTemplateVariable[] = [];

  if (variableNames.length > 0) {
    console.log('');
    console.log(chalk.gray(`Found ${variableNames.length} variable${variableNames.length === 1 ? '' : 's'}: ${variableNames.join(', ')}`));
    console.log(chalk.gray('Enter default values for each variable:'));
    console.log('');

    for (const varName of variableNames) {
      const defaultValue = await prompt(`  Default for "${varName}"`);
      const varDescription = await prompt(`  Description for "${varName}" (optional)`);

      variables.push({
        name: varName,
        description: varDescription || `Value for ${varName}`,
        defaultValue: defaultValue || '',
      });
    }
  }

  // Ask if this should be the default template
  console.log('');
  const isDefault = await confirm('Set as default template?', false);

  // Create the template
  console.log('');
  console.log(chalk.gray('Creating template...'));

  // WHY user_id NOT in the body: the /api/v1/templates POST endpoint takes
  // user_id from the authenticated apiClient context (Bearer styrby_*) and
  // rejects any user_id in the body via Zod .strict(). Passing it would
  // produce a 400 mass-assignment-guard rejection.
  try {
    await apiClient.createTemplate({
      name: name.trim(),
      content: content.trim(),
      description: description || undefined,
      variables,
      is_default: isDefault,
    });
  } catch (err) {
    handleApiError(err, 'create template');
    return; // unreachable
  }

  console.log(chalk.green(`\nTemplate "${name}" created successfully!`));

  if (isDefault) {
    console.log(chalk.gray('This template will be applied to new sessions by default.'));
  }

  console.log('');
}

/**
 * Handle `styrby template show <name>` - Display template details.
 *
 * Shows the full content of a template along with its variables and metadata.
 *
 * @param args - Command arguments [name]
 * @returns Promise that resolves when template is displayed
 */
async function handleTemplateShow(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    console.log(chalk.red('\nTemplate name is required.'));
    console.log(chalk.gray('Usage: styrby template show <name>'));
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  // WHY list+filter (not GET by name): /api/v1/templates/[id] takes a UUID,
  // not a name. The existing CLI ergonomics use `styrby template show <name>`
  // — we keep that UX by listing the user's templates (typically <50) and
  // filtering case-insensitively client-side. Server-side name filtering
  // would need a new endpoint; the list is small enough that this is fine.
  const row = await findTemplateByName(apiClient, name);
  if (!row) {
    console.log(chalk.red(`\nTemplate "${name}" not found.`));
    console.log(chalk.gray('Use "styrby template list" to see available templates.'));
    process.exit(1);
  }

  const template = contextTemplateFromRow(row as unknown as ContextTemplateRow);

  // Display template details
  console.log('');
  console.log(chalk.bold(`Template: ${template.name}`));
  console.log(chalk.gray('─'.repeat(60)));

  if (template.description) {
    console.log(chalk.gray(`Description: ${template.description}`));
  }

  console.log(chalk.gray(`Default: ${template.isDefault ? 'Yes' : 'No'}`));
  console.log(chalk.gray(`Created: ${new Date(template.createdAt).toLocaleString()}`));
  console.log(chalk.gray(`Updated: ${new Date(template.updatedAt).toLocaleString()}`));

  if (template.variables.length > 0) {
    console.log('');
    console.log(chalk.bold('Variables:'));
    for (const variable of template.variables) {
      const defaultVal = variable.defaultValue
        ? chalk.cyan(` = "${variable.defaultValue}"`)
        : chalk.gray(' (no default)');
      console.log(`  {{${variable.name}}}${defaultVal}`);
      if (variable.description) {
        console.log(chalk.gray(`    ${variable.description}`));
      }
    }
  }

  console.log('');
  console.log(chalk.bold('Content:'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(template.content);
  console.log(chalk.gray('─'.repeat(60)));
  console.log('');
}

/**
 * Handle `styrby template use <name>` - Output rendered template content.
 *
 * Renders the template with variable substitution. If variables are defined,
 * prompts the user for values (using defaults if Enter is pressed).
 *
 * @param args - Command arguments [name, --var=value, ...]
 * @returns Promise that resolves when template is rendered
 */
async function handleTemplateUse(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    console.log(chalk.red('\nTemplate name is required.'));
    console.log(chalk.gray('Usage: styrby template use <name> [--var=value ...]'));
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  // Parse variable overrides from command line (--varname=value)
  const variableOverrides: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      const eqIndex = arg.indexOf('=');
      const varName = arg.slice(2, eqIndex);
      const varValue = arg.slice(eqIndex + 1);
      variableOverrides[varName] = varValue;
    }
  }

  const row = await findTemplateByName(apiClient, name);
  if (!row) {
    console.log(chalk.red(`\nTemplate "${name}" not found.`));
    console.log(chalk.gray('Use "styrby template list" to see available templates.'));
    process.exit(1);
  }

  const template = contextTemplateFromRow(row as unknown as ContextTemplateRow);

  // Collect variable values
  const values: Record<string, string> = { ...variableOverrides };

  // Prompt for any variables not provided via command line
  const missingVars = template.variables.filter((v) => !(v.name in values));

  if (missingVars.length > 0) {
    console.log('');
    console.log(chalk.gray('Enter values for template variables (press Enter for default):'));
    console.log('');

    for (const variable of missingVars) {
      const defaultHint = variable.defaultValue ? variable.defaultValue : 'none';
      const value = await prompt(`  ${variable.name}`, defaultHint);
      values[variable.name] = value || variable.defaultValue;
    }
    console.log('');
  }

  // Render the template
  const rendered = renderContextTemplate(template, values);

  // Output the rendered content
  console.log(chalk.bold(`Rendered Template: ${template.name}`));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(rendered.renderedContent);
  console.log(chalk.gray('─'.repeat(60)));
  console.log('');
}

/**
 * Handle `styrby template delete <name>` - Delete a template with confirmation.
 *
 * Asks for confirmation before deleting the template from Supabase.
 *
 * @param args - Command arguments [name]
 * @returns Promise that resolves when template is deleted
 */
async function handleTemplateDelete(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    console.log(chalk.red('\nTemplate name is required.'));
    console.log(chalk.gray('Usage: styrby template delete <name>'));
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  // First, find the template (case-insensitive name match via list filter).
  const row = await findTemplateByName(apiClient, name);
  if (!row) {
    console.log(chalk.red(`\nTemplate "${name}" not found.`));
    console.log(chalk.gray('Use "styrby template list" to see available templates.'));
    process.exit(1);
  }

  // Confirm deletion
  console.log('');
  const confirmed = await confirm(
    `Delete template "${chalk.bold(row.name)}"? This cannot be undone.`,
    false
  );

  if (!confirmed) {
    console.log(chalk.gray('\nDeletion cancelled.'));
    return;
  }

  try {
    await apiClient.deleteTemplate(row.id);
  } catch (err) {
    handleApiError(err, 'delete template');
    return; // unreachable
  }

  console.log(chalk.green(`\nTemplate "${row.name}" deleted successfully.`));
  console.log('');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get an authenticated apiClient, or print a friendly error and exit.
 *
 * Replaces the prior `ensureAuthenticated` (which built a Supabase client
 * from PersistedData.accessToken). Templates now flow through /api/v1/*
 * with a `styrby_*` Bearer token — Phase 4 of H41.
 *
 * @returns A StyrbyApiClient ready for use, or process exits with code 1.
 */
function ensureApiClientOrExit(): StyrbyApiClient {
  try {
    return getApiClient();
  } catch (err) {
    if (err instanceof MissingStyrbyKeyError) {
      console.log(chalk.red('\n' + err.message));
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Find a template by case-insensitive name match.
 *
 * The /api/v1/templates list endpoint returns the user's full template set
 * (no name filter on the server). Matching client-side keeps the existing
 * `styrby template show <name>` ergonomics while every operation flows
 * through the typed apiClient. Typical user has < 50 templates so the
 * list-and-filter pattern is fine.
 *
 * @returns The matching TemplateSummary, or null if no name matched.
 */
async function findTemplateByName(
  apiClient: StyrbyApiClient,
  name: string,
): Promise<TemplateSummary | null> {
  let result: Awaited<ReturnType<StyrbyApiClient['listTemplates']>>;
  try {
    result = await apiClient.listTemplates();
  } catch (err) {
    handleApiError(err, 'fetch template');
    return null; // unreachable
  }
  const lower = name.toLowerCase();
  return result.templates.find((t) => t.name.toLowerCase() === lower) ?? null;
}

/**
 * Print a contextual error from a StyrbyApiError (or any error) and exit.
 *
 * WHY a single helper: every callsite in this file wraps an apiClient call
 * with the same chalk-red error display. Extracting the pattern keeps the
 * handler bodies focused on flow, not error-formatting boilerplate.
 *
 * @param err - The thrown error from an apiClient call
 * @param verb - Action description used in the error message ("create template",
 *               "fetch templates", etc.)
 */
function handleApiError(err: unknown, verb: string): never {
  if (err instanceof StyrbyApiError) {
    console.log(chalk.red(`\nFailed to ${verb}: ${err.message}`));
    logger.debug('StyrbyApiError', { status: err.status, code: err.code });
  } else if (err instanceof Error) {
    console.log(chalk.red(`\nFailed to ${verb}: ${err.message}`));
  } else {
    console.log(chalk.red(`\nFailed to ${verb}: unknown error`));
  }
  process.exit(1);
}

// Suppress unused TemplateRow import — kept for type compatibility with
// future callers that need the full row shape outside the summary endpoint.
void (null as unknown as TemplateRow | undefined);

/**
 * Prompt for multiline input.
 *
 * Reads lines until the user enters two consecutive blank lines.
 *
 * @param message - Initial prompt message
 * @returns Promise resolving to the entered text
 */
async function promptMultiline(message: string): Promise<string> {
  const readline = await import('node:readline');

  return new Promise((resolve) => {
    const lines: string[] = [];
    let consecutiveEmpty = 0;

    process.stdout.write(message);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on('line', (line) => {
      if (line.trim() === '') {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          rl.close();
          resolve(lines.join('\n'));
          return;
        }
      } else {
        // Add any single blank line that was followed by content
        if (consecutiveEmpty === 1) {
          lines.push('');
        }
        consecutiveEmpty = 0;
        lines.push(line);
      }
    });

    rl.on('close', () => {
      resolve(lines.join('\n'));
    });
  });
}

/**
 * Print usage information for the template command.
 */
function printTemplateUsage(): void {
  console.log(`
${chalk.bold('Usage:')} styrby template <command> [options]

${chalk.bold('Commands:')}
  list                    List all your templates
  create <name>           Create a new template (interactive)
  show <name>             Display template details and content
  use <name>              Render template with variable substitution
  delete <name>           Delete a template (with confirmation)

${chalk.bold('Aliases:')}
  list    ls
  create  new, add
  show    view, get
  use     apply, render
  delete  rm, remove

${chalk.bold('Examples:')}
  styrby template list                     # List all templates
  styrby template create "Code Review"     # Create new template
  styrby template show "Bug Fix"           # View template details
  styrby template use "New Feature"        # Render with prompts
  styrby template use "New Feature" \\
    --project_name=MyApp                   # Render with variable override
  styrby template delete "Old Template"    # Delete with confirmation

${chalk.bold('Variables:')}
  Templates can include variables using {{variable_name}} syntax.
  When using a template, you'll be prompted for values, or you can
  pass them via --variable_name=value on the command line.

${chalk.bold('Default Template:')}
  One template can be marked as "default" and will be automatically
  applied to new agent sessions. Set this during creation or edit
  the template in the mobile app.
`);
}

export default { handleTemplate };
