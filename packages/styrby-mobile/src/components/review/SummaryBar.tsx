/**
 * SummaryBar — File count, total +/-, branch, and pending-comment counter.
 *
 * Sits directly under the header and gives the reviewer at-a-glance scope
 * before they dive into individual diffs.
 *
 * @module components/review/SummaryBar
 */

import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  COLOR_ACCENT,
  COLOR_ADD,
  COLOR_DEL,
  COLOR_MUTED,
  COLOR_SURFACE_ALT,
} from './constants';
import type { SummaryBarProps } from '@/types/review';

/**
 * Compact horizontal bar of review statistics.
 *
 * @param props - See `SummaryBarProps`
 * @returns React element
 */
export function SummaryBar({ fileCount, totals, gitBranch, pendingCommentCount }: SummaryBarProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: COLOR_SURFACE_ALT,
        gap: 16,
      }}
    >
      <Text style={{ color: COLOR_MUTED, fontSize: 13 }}>
        {fileCount} file{fileCount !== 1 ? 's' : ''}
      </Text>
      <Text style={{ color: COLOR_ADD, fontSize: 13, fontWeight: '600' }}>
        +{totals.additions}
      </Text>
      <Text style={{ color: COLOR_DEL, fontSize: 13, fontWeight: '600' }}>
        -{totals.deletions}
      </Text>
      {gitBranch && (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Ionicons name="git-branch-outline" size={13} color={COLOR_MUTED} />
          <Text style={{ color: COLOR_MUTED, fontSize: 12, marginLeft: 4 }}>{gitBranch}</Text>
        </View>
      )}
      {pendingCommentCount > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 'auto' as never }}>
          <Ionicons name="chatbubble" size={13} color={COLOR_ACCENT} />
          <Text style={{ color: COLOR_ACCENT, fontSize: 12, marginLeft: 4 }}>
            {pendingCommentCount}
          </Text>
        </View>
      )}
    </View>
  );
}
