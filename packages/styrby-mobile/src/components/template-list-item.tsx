/**
 * Template List Item Component
 *
 * A swipeable list item for displaying context templates. Supports:
 * - Tap to view/edit
 * - Swipe left to reveal delete action
 * - Long press to set as default
 * - Default badge indicator
 */

import { View, Text, Pressable, Animated } from 'react-native';
import { useRef, useCallback } from 'react';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import type { ContextTemplate } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

export interface TemplateListItemProps {
  /** The template to display */
  template: ContextTemplate;

  /** Callback when the item is tapped (view/edit) */
  onPress: (template: ContextTemplate) => void;

  /** Callback when long pressed (set as default) */
  onLongPress?: (template: ContextTemplate) => void;

  /** Callback when delete is triggered via swipe */
  onDelete: (template: ContextTemplate) => void;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Formats an ISO date string to a relative time string (e.g., "2d ago").
 *
 * @param isoString - ISO 8601 date string
 * @returns Human-readable relative time
 */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) return 'just now';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  if (diffSeconds < 604800) return `${Math.floor(diffSeconds / 86400)}d ago`;
  if (diffSeconds < 2592000) return `${Math.floor(diffSeconds / 604800)}w ago`;

  // For older dates, show the date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Truncates content to a single line preview.
 *
 * @param content - The full template content
 * @param maxLength - Maximum characters to show
 * @returns Truncated content string
 */
function getContentPreview(content: string, maxLength = 80): string {
  // Replace newlines with spaces and trim
  const singleLine = content.replace(/\s+/g, ' ').trim();

  if (singleLine.length <= maxLength) return singleLine;
  return singleLine.substring(0, maxLength - 3) + '...';
}

// ============================================================================
// Component
// ============================================================================

/**
 * A single template list item with swipe-to-delete functionality.
 *
 * Displays the template name, variable count, content preview, and
 * last modified time. Shows a "Default" badge if the template is
 * the user's default.
 *
 * @param props - Component props
 * @returns React element
 */
export function TemplateListItem({
  template,
  onPress,
  onLongPress,
  onDelete,
}: TemplateListItemProps) {
  const swipeableRef = useRef<Swipeable>(null);

  /**
   * Renders the delete action shown when swiping left.
   */
  const renderRightActions = useCallback(
    (
      progress: Animated.AnimatedInterpolation<number>,
      dragX: Animated.AnimatedInterpolation<number>
    ) => {
      // Scale animation for the delete button
      const scale = dragX.interpolate({
        inputRange: [-100, 0],
        outputRange: [1, 0.5],
        extrapolate: 'clamp',
      });

      return (
        <Pressable
          onPress={() => {
            swipeableRef.current?.close();
            onDelete(template);
          }}
          className="bg-red-500 justify-center items-center w-20"
          accessibilityRole="button"
          accessibilityLabel="Delete template"
        >
          <Animated.View style={{ transform: [{ scale }] }}>
            <Ionicons name="trash-outline" size={24} color="white" />
          </Animated.View>
        </Pressable>
      );
    },
    [onDelete, template]
  );

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      friction={2}
      overshootRight={false}
    >
      <Pressable
        onPress={() => onPress(template)}
        onLongPress={() => onLongPress?.(template)}
        delayLongPress={500}
        className="bg-background px-4 py-3 border-b border-zinc-800/50 active:bg-zinc-900"
        accessibilityRole="button"
        accessibilityLabel={`Template: ${template.name}${template.isDefault ? ', Default template' : ''}. Long press to set as default.`}
      >
        <View className="flex-row items-start">
          {/* Template Icon */}
          <View className="w-10 h-10 rounded-full bg-brand/20 items-center justify-center mr-3">
            <Ionicons name="document-text" size={20} color="#f97316" />
          </View>

          {/* Template Info */}
          <View className="flex-1">
            {/* Title Row with Default Badge and Timestamp */}
            <View className="flex-row items-center justify-between mb-1">
              <View className="flex-row items-center flex-1 mr-2">
                <Text
                  className="text-white font-semibold"
                  numberOfLines={1}
                >
                  {template.name}
                </Text>

                {/* Default Badge */}
                {template.isDefault && (
                  <View className="bg-brand/20 px-2 py-0.5 rounded ml-2">
                    <Text className="text-brand text-xs font-medium">Default</Text>
                  </View>
                )}
              </View>

              <Text className="text-zinc-500 text-xs">
                {formatRelativeTime(template.updatedAt)}
              </Text>
            </View>

            {/* Description or Content Preview */}
            <Text className="text-zinc-400 text-sm mb-1" numberOfLines={1}>
              {template.description || getContentPreview(template.content)}
            </Text>

            {/* Metadata Row */}
            <View className="flex-row items-center mt-1">
              {/* Variable Count */}
              {template.variables.length > 0 && (
                <View className="flex-row items-center mr-3">
                  <Ionicons name="code-slash" size={12} color="#71717a" />
                  <Text className="text-zinc-500 text-xs ml-1">
                    {template.variables.length} variable{template.variables.length !== 1 ? 's' : ''}
                  </Text>
                </View>
              )}

              {/* Content Length Indicator */}
              <View className="flex-row items-center">
                <Ionicons name="text" size={12} color="#71717a" />
                <Text className="text-zinc-500 text-xs ml-1">
                  {template.content.length} chars
                </Text>
              </View>
            </View>
          </View>

          {/* Chevron */}
          <View className="justify-center ml-2">
            <Ionicons name="chevron-forward" size={20} color="#71717a" />
          </View>
        </View>
      </Pressable>
    </Swipeable>
  );
}
