-- ============================================================================
-- STYRBY DATABASE MIGRATION: Context Templates
-- ============================================================================
-- Adds the context_templates table for Wave 1A: Context Templates feature.
--
-- Context templates allow users to define reusable project context that can
-- be injected into agent sessions. Templates support variables (placeholders)
-- that get substituted at runtime.
--
-- Key differences from prompt_templates:
-- - prompt_templates: Short prompts for specific tasks (e.g., "debug this error")
-- - context_templates: Longer project context (e.g., "project architecture", "coding standards")
--
-- Design:
-- - Each user can have multiple templates
-- - One template can be marked as default (auto-applied to new sessions)
-- - Variables support name, description, and default values
-- - Full RLS protection - users can only access their own templates
-- ============================================================================


-- ============================================================================
-- CONTEXT_TEMPLATES TABLE
-- ============================================================================
-- Reusable project context that can be injected into agent sessions.
-- Supports variable placeholders that get substituted at runtime.
-- ============================================================================

CREATE TABLE context_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Template metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Template content (the actual context to inject)
  -- May contain {{variable_name}} placeholders that get substituted
  content TEXT NOT NULL,

  -- Variable definitions for placeholders in content
  -- Schema: [{ "name": "language", "description": "Programming language", "defaultValue": "TypeScript" }]
  variables JSONB DEFAULT '[]'::JSONB NOT NULL,

  -- Whether this template is automatically applied to new sessions
  -- Only one template per user can be default (enforced at application level)
  is_default BOOLEAN DEFAULT FALSE NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Constraints
  CONSTRAINT context_templates_name_not_empty CHECK (LENGTH(TRIM(name)) > 0),
  CONSTRAINT context_templates_content_not_empty CHECK (LENGTH(TRIM(content)) > 0),
  CONSTRAINT context_templates_variables_is_array CHECK (jsonb_typeof(variables) = 'array')
);


-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary lookup: user's templates sorted by creation date
-- Covering index includes commonly accessed fields for list view
CREATE INDEX idx_context_templates_user ON context_templates(user_id, created_at DESC)
  INCLUDE (name, description, is_default);

-- Find user's default template (used when starting new sessions)
CREATE INDEX idx_context_templates_default ON context_templates(user_id)
  WHERE is_default = TRUE;


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- Users can only access their own context templates.
-- Using (SELECT auth.uid()) for query plan caching optimization.
-- ============================================================================

ALTER TABLE context_templates ENABLE ROW LEVEL SECURITY;

-- Select: Users can only view their own templates
CREATE POLICY "context_templates_select_own"
  ON context_templates FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Insert: Users can only create templates for themselves
CREATE POLICY "context_templates_insert_own"
  ON context_templates FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Update: Users can only update their own templates
CREATE POLICY "context_templates_update_own"
  ON context_templates FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Delete: Users can only delete their own templates
CREATE POLICY "context_templates_delete_own"
  ON context_templates FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- TRIGGERS: AUTO-UPDATE TIMESTAMPS
-- ============================================================================
-- Reuses the update_updated_at() function from 001_initial_schema.sql

CREATE TRIGGER tr_context_templates_updated_at
  BEFORE UPDATE ON context_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================================
-- FUNCTION: Ensure only one default template per user
-- ============================================================================
-- When setting a template as default, automatically unset any existing default.
-- This prevents application-level race conditions.

CREATE OR REPLACE FUNCTION ensure_single_default_context_template()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when is_default is being set to TRUE
  IF NEW.is_default = TRUE AND (TG_OP = 'INSERT' OR OLD.is_default = FALSE) THEN
    -- Unset any existing default for this user (excluding the current row)
    UPDATE context_templates
    SET is_default = FALSE
    WHERE user_id = NEW.user_id
      AND id != NEW.id
      AND is_default = TRUE;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_context_templates_single_default
  BEFORE INSERT OR UPDATE ON context_templates
  FOR EACH ROW EXECUTE FUNCTION ensure_single_default_context_template();


-- ============================================================================
-- SEED DATA: DEFAULT CONTEXT TEMPLATES
-- ============================================================================
-- These are user-owned templates that get created when a user signs up.
-- We don't use system templates (user_id = NULL) here because:
-- 1. Users should be able to edit/delete these
-- 2. Each user gets their own copy to customize
--
-- Instead, we create a function that seeds default templates for new users.
-- ============================================================================

-- Function to seed default templates for a new user
CREATE OR REPLACE FUNCTION seed_default_context_templates(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO context_templates (user_id, name, description, content, variables, is_default)
  VALUES
    -- Code Review Template
    (
      p_user_id,
      'Code Review',
      'Context for reviewing code changes with focus on quality, security, and best practices.',
      E'## Code Review Context\n\nYou are reviewing code in {{project_name}}.\n\n### Review Focus Areas\n- **Correctness**: Does the code do what it''s supposed to do?\n- **Security**: Are there any security vulnerabilities (XSS, injection, auth issues)?\n- **Performance**: Are there any obvious performance problems?\n- **Maintainability**: Is the code readable and well-structured?\n- **Testing**: Are edge cases handled? Are tests adequate?\n\n### Project Standards\n- Language: {{language}}\n- Framework: {{framework}}\n- Style Guide: Follow existing patterns in the codebase\n\n### Instructions\nProvide specific, actionable feedback. Reference line numbers. Explain the \"why\" behind suggestions.',
      '[
        {"name": "project_name", "description": "Name of the project being reviewed", "defaultValue": "this project"},
        {"name": "language", "description": "Primary programming language", "defaultValue": "TypeScript"},
        {"name": "framework", "description": "Framework or library in use", "defaultValue": "React"}
      ]'::JSONB,
      FALSE
    ),

    -- Bug Fix Template
    (
      p_user_id,
      'Bug Fix',
      'Context for debugging and fixing bugs with a systematic approach.',
      E'## Bug Fix Context\n\nYou are helping fix a bug in {{project_name}}.\n\n### Debugging Approach\n1. **Reproduce**: Understand the exact steps to reproduce the bug\n2. **Isolate**: Find the minimal code path that triggers the issue\n3. **Understand**: Determine the root cause, not just symptoms\n4. **Fix**: Implement a targeted fix that addresses the root cause\n5. **Verify**: Confirm the fix works and doesn''t break other things\n6. **Prevent**: Consider if tests or types could prevent regression\n\n### Error Information\n- Error Type: {{error_type}}\n- Where: {{location}}\n\n### Instructions\n- Ask clarifying questions if the bug description is unclear\n- Explain what''s causing the bug before proposing a fix\n- Consider edge cases that might be affected\n- Suggest tests to prevent regression',
      '[
        {"name": "project_name", "description": "Name of the project", "defaultValue": "this project"},
        {"name": "error_type", "description": "Type of error (runtime, type error, logic bug, etc.)", "defaultValue": "runtime error"},
        {"name": "location", "description": "Where the bug occurs", "defaultValue": "unknown"}
      ]'::JSONB,
      FALSE
    ),

    -- New Feature Template
    (
      p_user_id,
      'New Feature',
      'Context for implementing new features with proper planning and architecture.',
      E'## New Feature Context\n\nYou are implementing a new feature in {{project_name}}.\n\n### Feature: {{feature_name}}\n{{feature_description}}\n\n### Implementation Approach\n1. **Plan**: Outline the changes needed before writing code\n2. **Types**: Define TypeScript types/interfaces first\n3. **Core Logic**: Implement the main functionality\n4. **Integration**: Connect to existing systems (API, state, UI)\n5. **Error Handling**: Add proper error handling and edge cases\n6. **Testing**: Write tests for critical paths\n7. **Documentation**: Add JSDoc comments and update any docs\n\n### Architecture Guidelines\n- Follow existing patterns in the codebase\n- Keep components/functions small and focused\n- Prefer composition over inheritance\n- Make state changes predictable\n\n### Instructions\n- Start by outlining your implementation plan\n- Ask clarifying questions about requirements if needed\n- Consider backward compatibility and migration needs\n- Think about error states and loading states',
      '[
        {"name": "project_name", "description": "Name of the project", "defaultValue": "this project"},
        {"name": "feature_name", "description": "Short name for the feature", "defaultValue": "new feature"},
        {"name": "feature_description", "description": "Detailed description of what the feature should do", "defaultValue": "TBD - describe the feature requirements"}
      ]'::JSONB,
      FALSE
    ),

    -- Refactor Template
    (
      p_user_id,
      'Refactor',
      'Context for refactoring code while preserving behavior and improving quality.',
      E'## Refactor Context\n\nYou are refactoring code in {{project_name}}.\n\n### Refactoring Goals\n- **Preserve Behavior**: The code must work exactly the same after refactoring\n- **Improve {{focus_area}}**: Primary area to improve\n- **Incremental Changes**: Make small, reversible changes\n- **Test Coverage**: Ensure tests pass throughout\n\n### Refactoring Techniques\n- Extract functions/components for reusability\n- Rename for clarity (variables, functions, files)\n- Simplify conditionals and reduce nesting\n- Remove dead code and unused dependencies\n- Consolidate duplicated logic\n- Improve type safety\n\n### Safety Checklist\n- [ ] Tests pass before starting\n- [ ] Make one change at a time\n- [ ] Verify tests pass after each change\n- [ ] Keep commits small and focused\n\n### Instructions\n- Explain the refactoring plan before making changes\n- Prioritize changes by impact vs. risk\n- If unsure about behavior, ask before changing\n- Document any assumptions made',
      '[
        {"name": "project_name", "description": "Name of the project", "defaultValue": "this project"},
        {"name": "focus_area", "description": "What aspect to improve (readability, performance, type safety, modularity)", "defaultValue": "readability"}
      ]'::JSONB,
      FALSE
    ),

    -- Documentation Template (marked as default)
    (
      p_user_id,
      'Documentation',
      'Context for writing clear, comprehensive documentation.',
      E'## Documentation Context\n\nYou are writing documentation for {{project_name}}.\n\n### Documentation Type: {{doc_type}}\n\n### Writing Guidelines\n- **Audience**: Assume the reader is a competent developer but unfamiliar with this codebase\n- **Clarity**: Use simple, direct language; avoid jargon\n- **Examples**: Include code examples for non-obvious usage\n- **Structure**: Use headings, lists, and code blocks for readability\n- **Accuracy**: Ensure code examples actually work\n\n### Documentation Standards\n- Functions: JSDoc with @param, @returns, @throws, @example\n- APIs: HTTP method, path, auth, request/response schemas, errors\n- Components: Props interface, usage examples, edge cases\n- README: Purpose, installation, quick start, configuration\n\n### Instructions\n- Match the existing documentation style in the codebase\n- Focus on \"why\" and \"how to use\" rather than \"what it does\"\n- Update related docs when making changes\n- Include gotchas and common pitfalls',
      '[
        {"name": "project_name", "description": "Name of the project", "defaultValue": "this project"},
        {"name": "doc_type", "description": "Type of documentation (README, API docs, component docs, inline comments)", "defaultValue": "inline comments"}
      ]'::JSONB,
      TRUE  -- This is the default template
    );
END;
$$;


-- ============================================================================
-- TRIGGER: Seed default templates for new users
-- ============================================================================
-- When a new profile is created (triggered by auth.users insert),
-- automatically create the 5 default context templates.

CREATE OR REPLACE FUNCTION handle_new_user_context_templates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_default_context_templates(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_profile_created_seed_context_templates
  AFTER INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION handle_new_user_context_templates();


-- ============================================================================
-- GRANTS FOR SERVICE ROLE
-- ============================================================================

GRANT ALL ON context_templates TO service_role;


-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
