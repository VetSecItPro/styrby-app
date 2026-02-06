/**
 * Context Templates Types
 *
 * Type definitions for the context templates feature (Wave 1A).
 * Context templates allow users to define reusable project context
 * that can be injected into agent sessions with variable substitution.
 */

/**
 * Represents a variable placeholder within a context template.
 * Variables are defined in template content as {{variable_name}} and
 * get substituted with user-provided values at runtime.
 *
 * @example
 * const variable: ContextTemplateVariable = {
 *   name: "language",
 *   description: "Programming language used in the project",
 *   defaultValue: "TypeScript"
 * };
 */
export interface ContextTemplateVariable {
  /**
   * Variable identifier used in template content.
   * Must match the placeholder syntax: {{name}}
   * @example "project_name", "language", "framework"
   */
  name: string;

  /**
   * Human-readable description of what this variable represents.
   * Shown in the UI when prompting users to fill in values.
   */
  description: string;

  /**
   * Default value used if the user doesn't provide one.
   * Can be an empty string for required variables.
   */
  defaultValue: string;
}

/**
 * Represents a context template as stored in the database.
 * Context templates are user-created and can be applied to agent sessions
 * to provide consistent project context.
 */
export interface ContextTemplate {
  /** Unique identifier (UUID) */
  id: string;

  /** ID of the user who owns this template */
  userId: string;

  /** User-visible name of the template */
  name: string;

  /**
   * Optional description explaining when to use this template.
   * Shown in template selection UI.
   */
  description: string | null;

  /**
   * The actual template content with optional variable placeholders.
   * Placeholders use {{variable_name}} syntax.
   *
   * @example
   * "You are working on {{project_name}} using {{language}}."
   */
  content: string;

  /**
   * Variable definitions for placeholders in the content.
   * Each variable has a name, description, and default value.
   */
  variables: ContextTemplateVariable[];

  /**
   * Whether this template is automatically applied to new sessions.
   * Only one template per user can be the default.
   */
  isDefault: boolean;

  /** When the template was created */
  createdAt: string;

  /** When the template was last updated */
  updatedAt: string;
}

/**
 * Input for creating a new context template.
 * Used by the API and UI when creating templates.
 */
export interface CreateContextTemplateInput {
  /** User-visible name of the template */
  name: string;

  /** Optional description explaining when to use this template */
  description?: string;

  /**
   * The template content with optional {{variable}} placeholders.
   * Must not be empty.
   */
  content: string;

  /**
   * Variable definitions for any placeholders in the content.
   * Order determines the order in which users are prompted for values.
   */
  variables?: ContextTemplateVariable[];

  /**
   * Whether to set this as the default template.
   * If true, any existing default will be unset.
   */
  isDefault?: boolean;
}

/**
 * Input for updating an existing context template.
 * All fields are optional - only provided fields are updated.
 */
export interface UpdateContextTemplateInput {
  /** New name for the template */
  name?: string;

  /** New description for the template */
  description?: string | null;

  /** New content for the template */
  content?: string;

  /** Updated variable definitions */
  variables?: ContextTemplateVariable[];

  /**
   * Whether to set this as the default template.
   * If true, any existing default will be unset.
   */
  isDefault?: boolean;
}

/**
 * Result of rendering a template with variable values.
 * The content has all {{variable}} placeholders replaced with actual values.
 */
export interface RenderedContextTemplate {
  /** The original template ID */
  templateId: string;

  /** The template name */
  templateName: string;

  /**
   * The fully rendered content with all variables substituted.
   * Ready to be injected into an agent session.
   */
  renderedContent: string;

  /**
   * The variable values that were used for rendering.
   * Maps variable name to the value used.
   */
  appliedVariables: Record<string, string>;
}

/**
 * Maps database column names to TypeScript property names.
 * Used for transforming database rows to ContextTemplate objects.
 *
 * @internal
 */
export interface ContextTemplateRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  content: string;
  variables: ContextTemplateVariable[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Transforms a database row to a ContextTemplate object.
 * Converts snake_case column names to camelCase property names.
 *
 * @param row - The database row from Supabase
 * @returns The transformed ContextTemplate object
 *
 * @example
 * const row = await supabase.from('context_templates').select().single();
 * const template = contextTemplateFromRow(row.data);
 */
export function contextTemplateFromRow(row: ContextTemplateRow): ContextTemplate {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    content: row.content,
    variables: row.variables,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Renders a template by substituting variables with provided values.
 * Uses default values for any variables not explicitly provided.
 *
 * @param template - The template to render
 * @param values - Object mapping variable names to values (optional)
 * @returns The rendered template with all variables substituted
 *
 * @example
 * const template = { content: "Working on {{project}} with {{language}}", ... };
 * const rendered = renderContextTemplate(template, { project: "MyApp" });
 * // rendered.renderedContent = "Working on MyApp with TypeScript" (using default for language)
 */
export function renderContextTemplate(
  template: ContextTemplate,
  values: Record<string, string> = {}
): RenderedContextTemplate {
  const appliedVariables: Record<string, string> = {};
  let renderedContent = template.content;

  // Build the applied variables map and substitute
  for (const variable of template.variables) {
    const value = values[variable.name] ?? variable.defaultValue;
    appliedVariables[variable.name] = value;

    // Replace all occurrences of {{variable_name}} with the value
    const placeholder = new RegExp(`\\{\\{\\s*${variable.name}\\s*\\}\\}`, 'g');
    renderedContent = renderedContent.replace(placeholder, value);
  }

  return {
    templateId: template.id,
    templateName: template.name,
    renderedContent,
    appliedVariables,
  };
}

/**
 * Extracts variable names from template content.
 * Useful for validating that all variables in content have definitions.
 *
 * @param content - The template content to parse
 * @returns Array of unique variable names found in the content
 *
 * @example
 * const names = extractVariableNames("Working on {{project}} with {{language}}");
 * // names = ["project", "language"]
 */
export function extractVariableNames(content: string): string[] {
  const pattern = /\{\{\s*(\w+)\s*\}\}/g;
  const names = new Set<string>();

  let match;
  while ((match = pattern.exec(content)) !== null) {
    names.add(match[1]);
  }

  return Array.from(names);
}

/**
 * Validates that a template's variable definitions cover all placeholders in content.
 *
 * @param content - The template content
 * @param variables - The variable definitions
 * @returns Object with isValid boolean and any missing variable names
 *
 * @example
 * const result = validateTemplateVariables(
 *   "Working on {{project}} with {{language}}",
 *   [{ name: "project", description: "", defaultValue: "" }]
 * );
 * // result = { isValid: false, missingVariables: ["language"] }
 */
export function validateTemplateVariables(
  content: string,
  variables: ContextTemplateVariable[]
): { isValid: boolean; missingVariables: string[] } {
  const usedNames = extractVariableNames(content);
  const definedNames = new Set(variables.map((v) => v.name));

  const missingVariables = usedNames.filter((name) => !definedNames.has(name));

  return {
    isValid: missingVariables.length === 0,
    missingVariables,
  };
}
