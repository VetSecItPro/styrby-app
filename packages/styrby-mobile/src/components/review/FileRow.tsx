/**
 * FileRow — One expandable file in the code review list.
 *
 * Tap the row to reveal the inline DiffViewer. Below the diff, an inline
 * comment input lets the reviewer attach a file-level note before submitting
 * their decision.
 *
 * WHY split out: Self-contained interactive unit with its own local state
 * (expanded toggle is owned by the parent, but `showCommentInput` and
 * `commentText` are purely local). Extraction keeps the orchestrator focused
 * on data + layout.
 *
 * @module components/review/FileRow
 */

import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DiffViewer } from '../DiffViewer';
import {
  COLOR_ACCENT,
  COLOR_ADD,
  COLOR_BORDER,
  COLOR_DEL,
  COLOR_MUTED,
  COLOR_PLACEHOLDER,
  COLOR_SURFACE,
} from './constants';
import type { FileRowProps } from '@/types/review';

/**
 * Renders a single file row with expand-to-diff behavior and a per-file
 * comment input.
 *
 * @param props - See `FileRowProps`
 * @returns React element
 */
export function FileRow({ file, isExpanded, onToggle, onAddComment }: FileRowProps) {
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentText, setCommentText] = useState('');

  // WHY: Trim and short-circuit so empty/whitespace-only comments don't get
  // appended to the pending list (they would render as blank rows).
  const handleSubmitComment = useCallback(() => {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    onAddComment(file.path, trimmed);
    setCommentText('');
    setShowCommentInput(false);
  }, [commentText, file.path, onAddComment]);

  return (
    <View style={{ marginBottom: 4 }}>
      {/* Tap row to expand diff */}
      <Pressable
        onPress={onToggle}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: COLOR_SURFACE,
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: isExpanded ? undefined : 10,
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
          borderWidth: 1,
          borderColor: COLOR_BORDER,
        }}
        accessibilityRole="button"
        accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} ${file.path}`}
        accessibilityState={{ expanded: isExpanded }}
      >
        <Ionicons name="document-text-outline" size={16} color={COLOR_MUTED} />
        <Text
          style={{
            color: '#e4e4e7',
            fontSize: 13,
            fontFamily: 'monospace',
            flex: 1,
            marginLeft: 8,
          }}
          numberOfLines={1}
        >
          {file.path}
        </Text>
        <Text style={{ color: COLOR_ADD, fontSize: 12, fontWeight: '600', marginRight: 8 }}>
          +{file.additions}
        </Text>
        <Text style={{ color: COLOR_DEL, fontSize: 12, fontWeight: '600', marginRight: 8 }}>
          -{file.deletions}
        </Text>
        <Ionicons
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={COLOR_MUTED}
        />
      </Pressable>

      {/* Expanded diff view */}
      {isExpanded && (
        <View
          style={{
            borderWidth: 1,
            borderTopWidth: 0,
            borderColor: COLOR_BORDER,
            borderBottomLeftRadius: 10,
            borderBottomRightRadius: 10,
            overflow: 'hidden',
          }}
        >
          <DiffViewer file={file} showLineNumbers defaultCollapsed={false} />

          {/* Comment input toggle */}
          <View
            style={{
              backgroundColor: COLOR_SURFACE,
              paddingHorizontal: 12,
              paddingBottom: 10,
            }}
          >
            {showCommentInput ? (
              <View>
                <TextInput
                  value={commentText}
                  onChangeText={setCommentText}
                  placeholder="Add a comment on this file..."
                  placeholderTextColor={COLOR_PLACEHOLDER}
                  multiline
                  style={{
                    backgroundColor: '#27272a',
                    color: 'white',
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 13,
                    minHeight: 60,
                    textAlignVertical: 'top',
                    marginBottom: 8,
                  }}
                  accessibilityLabel={`Comment on ${file.path}`}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    onPress={() => {
                      setShowCommentInput(false);
                      setCommentText('');
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: '#27272a',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel comment"
                  >
                    <Text style={{ color: COLOR_MUTED, fontSize: 13 }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleSubmitComment}
                    disabled={!commentText.trim()}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: commentText.trim() ? COLOR_ACCENT : '#3f3f46',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Submit comment"
                  >
                    <Text style={{ color: 'white', fontSize: 13, fontWeight: '600' }}>
                      Add Comment
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={() => setShowCommentInput(true)}
                style={{ flexDirection: 'row', alignItems: 'center' }}
                accessibilityRole="button"
                accessibilityLabel={`Add a comment on ${file.path}`}
              >
                <Ionicons name="chatbubble-outline" size={14} color={COLOR_MUTED} />
                <Text style={{ color: COLOR_MUTED, fontSize: 12, marginLeft: 6 }}>
                  Add comment on this file
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
