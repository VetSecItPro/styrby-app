/**
 * Templates Screen
 *
 * Displays the user's context templates with full CRUD functionality:
 * - List all templates in a FlatList
 * - FAB to create new template (opens form sheet)
 * - Tap template to view/edit (opens form sheet)
 * - Swipe left to delete with confirmation
 * - Long press to set as default
 * - Visual "Default" badge on the default template
 *
 * Navigated to from Settings screen.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  useContextTemplates,
  type UseContextTemplatesResult,
} from '../src/hooks/useContextTemplates';
import { TemplateListItem } from '../src/components/template-list-item';
import { TemplateFormSheet } from '../src/components/template-form-sheet';
import type {
  ContextTemplate,
  CreateContextTemplateInput,
  UpdateContextTemplateInput,
} from 'styrby-shared';

// ============================================================================
// Screen Component
// ============================================================================

/**
 * Templates screen component.
 *
 * Renders a list of the user's context templates with full management
 * capabilities. Uses the useContextTemplates hook for data fetching
 * and mutations.
 *
 * @returns React element
 */
export default function TemplatesScreen() {
  const router = useRouter();

  // Template data and mutations from hook
  const {
    templates,
    isLoading,
    isMutating,
    error,
    refresh,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
  }: UseContextTemplatesResult = useContextTemplates();

  // Form sheet state
  const [isFormVisible, setIsFormVisible] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ContextTemplate | null>(null);

  // Refresh control state
  const [isRefreshing, setIsRefreshing] = useState(false);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Opens the form sheet for creating a new template.
   */
  const handleCreatePress = useCallback(() => {
    setEditingTemplate(null);
    setIsFormVisible(true);
  }, []);

  /**
   * Opens the form sheet for editing an existing template.
   *
   * @param template - The template to edit
   */
  const handleTemplatePress = useCallback((template: ContextTemplate) => {
    setEditingTemplate(template);
    setIsFormVisible(true);
  }, []);

  /**
   * Prompts for confirmation and sets a template as the default.
   *
   * @param template - The template to set as default
   */
  const handleLongPress = useCallback(
    (template: ContextTemplate) => {
      if (template.isDefault) {
        // Already the default, show info
        Alert.alert(
          'Default Template',
          `"${template.name}" is already your default template.`
        );
        return;
      }

      Alert.alert(
        'Set as Default?',
        `Do you want to set "${template.name}" as your default template? It will be automatically applied to new sessions.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Set Default',
            onPress: async () => {
              const success = await setDefaultTemplate(template.id);
              if (!success) {
                Alert.alert('Error', 'Failed to set default template. Please try again.');
              }
            },
          },
        ]
      );
    },
    [setDefaultTemplate]
  );

  /**
   * Prompts for confirmation and deletes a template.
   *
   * @param template - The template to delete
   */
  const handleDelete = useCallback(
    (template: ContextTemplate) => {
      Alert.alert(
        'Delete Template?',
        `Are you sure you want to delete "${template.name}"? This action cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              const success = await deleteTemplate(template.id);
              if (!success) {
                Alert.alert('Error', 'Failed to delete template. Please try again.');
              }
            },
          },
        ]
      );
    },
    [deleteTemplate]
  );

  /**
   * Handles saving a template (create or update).
   *
   * @param input - The template input data
   * @param id - The template ID if updating, undefined if creating
   * @returns True if save succeeded, false otherwise
   */
  const handleSave = useCallback(
    async (
      input: CreateContextTemplateInput | UpdateContextTemplateInput,
      id?: string
    ): Promise<boolean> => {
      if (id) {
        // Updating existing template
        return await updateTemplate(id, input as UpdateContextTemplateInput);
      } else {
        // Creating new template
        const created = await createTemplate(input as CreateContextTemplateInput);
        return created !== null;
      }
    },
    [createTemplate, updateTemplate]
  );

  /**
   * Closes the form sheet.
   */
  const handleCloseForm = useCallback(() => {
    setIsFormVisible(false);
    setEditingTemplate(null);
  }, []);

  /**
   * Handles pull-to-refresh.
   */
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  // --------------------------------------------------------------------------
  // Render: Loading State
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading templates...</Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Error State
  // --------------------------------------------------------------------------

  if (error && templates.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">
          Failed to Load Templates
        </Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={refresh}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry loading templates"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Main
  // --------------------------------------------------------------------------

  return (
    <GestureHandlerRootView className="flex-1 bg-background">
      {/* Header Info */}
      <View className="px-4 py-3 border-b border-zinc-800/50">
        <Text className="text-zinc-400 text-sm">
          Context templates provide reusable project context for your agent sessions.
          Long press a template to set it as default.
        </Text>
      </View>

      {/* Templates List */}
      <FlatList
        data={templates}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TemplateListItem
            template={item}
            onPress={handleTemplatePress}
            onLongPress={handleLongPress}
            onDelete={handleDelete}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center py-20 px-6">
            <Ionicons name="document-text-outline" size={48} color="#3f3f46" />
            <Text className="text-zinc-400 font-semibold text-lg mt-4">
              No templates yet
            </Text>
            <Text className="text-zinc-500 text-center mt-2">
              Create your first context template to provide consistent project context to your AI agents.
            </Text>
            <Pressable
              onPress={handleCreatePress}
              className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80 flex-row items-center"
              accessibilityRole="button"
              accessibilityLabel="Create your first template"
            >
              <Ionicons name="add" size={20} color="white" />
              <Text className="text-white font-semibold ml-2">Create Template</Text>
            </Pressable>
          </View>
        }
        contentContainerStyle={
          templates.length === 0 ? { flexGrow: 1 } : { paddingBottom: 100 }
        }
        showsVerticalScrollIndicator={false}
      />

      {/* Floating Action Button */}
      {templates.length > 0 && (
        <View className="absolute bottom-6 right-6">
          <Pressable
            onPress={handleCreatePress}
            className="w-14 h-14 rounded-full bg-brand items-center justify-center shadow-lg active:opacity-80"
            style={{
              shadowColor: '#f97316',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3,
              shadowRadius: 8,
              elevation: 8,
            }}
            accessibilityRole="button"
            accessibilityLabel="Create new template"
          >
            <Ionicons name="add" size={28} color="white" />
          </Pressable>
        </View>
      )}

      {/* Form Sheet */}
      <TemplateFormSheet
        visible={isFormVisible}
        onClose={handleCloseForm}
        onSave={handleSave}
        template={editingTemplate}
        isSaving={isMutating}
      />
    </GestureHandlerRootView>
  );
}
