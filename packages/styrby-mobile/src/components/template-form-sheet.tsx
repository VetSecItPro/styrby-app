/**
 * Template Form Sheet Component
 *
 * A bottom sheet modal for creating and editing context templates.
 * Supports:
 * - Name, description, and content fields
 * - Variable extraction from content ({{variable}} syntax)
 * - Variable definition editing (description and default value)
 * - Default template toggle
 */

import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { useState, useCallback, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import type {
  ContextTemplate,
  CreateContextTemplateInput,
  UpdateContextTemplateInput,
  ContextTemplateVariable,
} from 'styrby-shared';
import { extractVariableNames, validateTemplateVariables } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

export interface TemplateFormSheetProps {
  /** Whether the sheet is visible */
  visible: boolean;

  /** Callback to close the sheet */
  onClose: () => void;

  /** Callback when the template is saved (create or update) */
  onSave: (
    input: CreateContextTemplateInput | UpdateContextTemplateInput,
    id?: string
  ) => Promise<boolean>;

  /** Template to edit (if null, creating a new template) */
  template?: ContextTemplate | null;

  /** Whether a save operation is in progress */
  isSaving?: boolean;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Bottom sheet form for creating or editing context templates.
 *
 * The form automatically extracts variable placeholders ({{name}}) from
 * the content field and allows editing their descriptions and default values.
 *
 * @param props - Component props
 * @returns React element
 */
export function TemplateFormSheet({
  visible,
  onClose,
  onSave,
  template,
  isSaving = false,
}: TemplateFormSheetProps) {
  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [variables, setVariables] = useState<ContextTemplateVariable[]>([]);
  const [isDefault, setIsDefault] = useState(false);

  // Validation
  const [nameError, setNameError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // Effects
  // --------------------------------------------------------------------------

  /**
   * Reset form when sheet opens/closes or template changes.
   */
  useEffect(() => {
    if (visible) {
      if (template) {
        // Editing existing template
        setName(template.name);
        setDescription(template.description ?? '');
        setContent(template.content);
        setVariables(template.variables);
        setIsDefault(template.isDefault);
      } else {
        // Creating new template
        setName('');
        setDescription('');
        setContent('');
        setVariables([]);
        setIsDefault(false);
      }
      setNameError(null);
      setContentError(null);
    }
  }, [visible, template]);

  /**
   * Extract and sync variables when content changes.
   */
  useEffect(() => {
    const extractedNames = extractVariableNames(content);

    setVariables((prevVariables) => {
      // Keep existing variables that are still in content
      const existing = new Map(prevVariables.map((v) => [v.name, v]));

      // Build new variables array
      return extractedNames.map((varName) => {
        const existingVar = existing.get(varName);
        return existingVar ?? {
          name: varName,
          description: '',
          defaultValue: '',
        };
      });
    });
  }, [content]);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Validates the form and returns true if valid.
   */
  const validateForm = useCallback((): boolean => {
    let isValid = true;

    // Validate name
    if (!name.trim()) {
      setNameError('Name is required');
      isValid = false;
    } else {
      setNameError(null);
    }

    // Validate content
    if (!content.trim()) {
      setContentError('Content is required');
      isValid = false;
    } else {
      setContentError(null);
    }

    return isValid;
  }, [name, content]);

  /**
   * Updates a specific variable's field.
   */
  const updateVariable = useCallback(
    (index: number, field: 'description' | 'defaultValue', value: string) => {
      setVariables((prev) =>
        prev.map((v, i) => (i === index ? { ...v, [field]: value } : v))
      );
    },
    []
  );

  /**
   * Handles the save button press.
   */
  const handleSave = useCallback(async () => {
    if (!validateForm()) return;

    const input: CreateContextTemplateInput | UpdateContextTemplateInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      content: content.trim(),
      variables,
      isDefault,
    };

    const success = await onSave(input, template?.id);

    if (success) {
      onClose();
    }
  }, [name, description, content, variables, isDefault, template, validateForm, onSave, onClose]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-end"
      >
        {/* Backdrop */}
        <Pressable
          className="flex-1"
          onPress={onClose}
          accessibilityLabel="Close template form"
        />

        {/* Sheet Content */}
        <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800 max-h-[90%]">
          {/* Header */}
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-white text-lg font-semibold">
              {template ? 'Edit Template' : 'New Template'}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={24} color="#71717a" />
            </Pressable>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Name Field */}
            <View className="mb-4">
              <Text className="text-zinc-400 text-sm mb-2">Name *</Text>
              <TextInput
                className={`bg-zinc-800 text-white rounded-xl px-4 py-3 text-base ${
                  nameError ? 'border border-red-500' : ''
                }`}
                placeholder="My Template"
                placeholderTextColor="#71717a"
                value={name}
                onChangeText={setName}
                maxLength={100}
                autoCapitalize="words"
                accessibilityLabel="Template name"
              />
              {nameError && (
                <Text className="text-red-500 text-xs mt-1">{nameError}</Text>
              )}
            </View>

            {/* Description Field */}
            <View className="mb-4">
              <Text className="text-zinc-400 text-sm mb-2">
                Description (optional)
              </Text>
              <TextInput
                className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base"
                placeholder="When to use this template..."
                placeholderTextColor="#71717a"
                value={description}
                onChangeText={setDescription}
                maxLength={300}
                multiline
                numberOfLines={2}
                accessibilityLabel="Template description"
              />
            </View>

            {/* Content Field */}
            <View className="mb-4">
              <View className="flex-row items-center justify-between mb-2">
                <Text className="text-zinc-400 text-sm">Content *</Text>
                <Text className="text-zinc-600 text-xs">
                  Use {'{{variable}}'} for placeholders
                </Text>
              </View>
              <TextInput
                className={`bg-zinc-800 text-white rounded-xl px-4 py-3 text-base min-h-[120px] ${
                  contentError ? 'border border-red-500' : ''
                }`}
                placeholder="You are working on {{project_name}} using {{language}}..."
                placeholderTextColor="#71717a"
                value={content}
                onChangeText={setContent}
                maxLength={5000}
                multiline
                textAlignVertical="top"
                accessibilityLabel="Template content"
              />
              {contentError && (
                <Text className="text-red-500 text-xs mt-1">{contentError}</Text>
              )}
              <Text className="text-zinc-600 text-xs text-right mt-1">
                {content.length}/5000
              </Text>
            </View>

            {/* Variables Section */}
            {variables.length > 0 && (
              <View className="mb-4">
                <Text className="text-zinc-400 text-sm mb-2">
                  Variables ({variables.length})
                </Text>
                <View className="bg-zinc-800 rounded-xl p-3">
                  {variables.map((variable, index) => (
                    <View
                      key={variable.name}
                      className={`${
                        index > 0 ? 'mt-4 pt-4 border-t border-zinc-700' : ''
                      }`}
                    >
                      {/* Variable Name */}
                      <View className="flex-row items-center mb-2">
                        <View className="bg-brand/20 px-2 py-1 rounded">
                          <Text className="text-brand text-xs font-mono">
                            {'{{'}{variable.name}{'}}'}
                          </Text>
                        </View>
                      </View>

                      {/* Variable Description */}
                      <TextInput
                        className="bg-zinc-700 text-white rounded-lg px-3 py-2 text-sm mb-2"
                        placeholder="Description (shown when filling in)"
                        placeholderTextColor="#52525b"
                        value={variable.description}
                        onChangeText={(value) =>
                          updateVariable(index, 'description', value)
                        }
                        maxLength={200}
                        accessibilityLabel={`Description for ${variable.name}`}
                      />

                      {/* Variable Default Value */}
                      <TextInput
                        className="bg-zinc-700 text-white rounded-lg px-3 py-2 text-sm"
                        placeholder="Default value (optional)"
                        placeholderTextColor="#52525b"
                        value={variable.defaultValue}
                        onChangeText={(value) =>
                          updateVariable(index, 'defaultValue', value)
                        }
                        maxLength={500}
                        accessibilityLabel={`Default value for ${variable.name}`}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Default Toggle */}
            <View className="flex-row items-center justify-between py-3 mb-4">
              <View>
                <Text className="text-white font-medium">Set as Default</Text>
                <Text className="text-zinc-500 text-sm">
                  Auto-apply to new sessions
                </Text>
              </View>
              <Switch
                value={isDefault}
                onValueChange={setIsDefault}
                trackColor={{ false: '#3f3f46', true: '#f9731650' }}
                thumbColor={isDefault ? '#f97316' : '#71717a'}
                accessibilityRole="switch"
                accessibilityLabel="Set as default template"
              />
            </View>

            {/* Save Button */}
            <Pressable
              onPress={handleSave}
              disabled={isSaving}
              className={`py-3 rounded-xl items-center ${
                isSaving ? 'bg-zinc-700' : 'bg-brand active:opacity-80'
              }`}
              accessibilityRole="button"
              accessibilityLabel={template ? 'Save changes' : 'Create template'}
            >
              {isSaving ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text className="text-white font-semibold">
                  {template ? 'Save Changes' : 'Create Template'}
                </Text>
              )}
            </Pressable>

            {/* Extra padding for keyboard */}
            <View className="h-4" />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
