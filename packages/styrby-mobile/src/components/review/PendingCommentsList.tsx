/**
 * PendingCommentsList — Recap of unsaved file-level comments.
 *
 * Renders below the file list so the reviewer can sanity-check their notes
 * before opening the decision modal. Returns null when empty so it doesn't
 * waste vertical space.
 *
 * @module components/review/PendingCommentsList
 */

import React from 'react';
import { View, Text } from 'react-native';
import { COLOR_BORDER, COLOR_SURFACE } from './constants';
import type { PendingCommentsListProps } from '@/types/review';

/**
 * Renders a card listing every pending comment with file path and body.
 *
 * @param props - See `PendingCommentsListProps`
 * @returns React element or null when there are no pending comments
 */
export function PendingCommentsList({ comments }: PendingCommentsListProps) {
  if (comments.length === 0) return null;

  return (
    <View
      style={{
        marginTop: 8,
        padding: 12,
        backgroundColor: COLOR_SURFACE,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: COLOR_BORDER,
      }}
    >
      <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 8 }}>
        {comments.length} PENDING COMMENT{comments.length !== 1 ? 'S' : ''}
      </Text>
      {comments.map((c) => (
        <View key={c.id} style={{ marginBottom: 6 }}>
          <Text style={{ color: '#71717a', fontSize: 11, fontFamily: 'monospace' }}>
            {c.filePath || 'General'}
          </Text>
          <Text style={{ color: '#d4d4d8', fontSize: 13 }}>{c.body}</Text>
        </View>
      ))}
    </View>
  );
}
