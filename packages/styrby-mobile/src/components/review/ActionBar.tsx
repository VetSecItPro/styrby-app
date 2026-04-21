/**
 * ActionBar — Reject / Request Changes / Approve buttons fixed to the bottom.
 *
 * Only rendered for pending reviews. While submitting, the Approve button
 * shows a spinner so the reviewer doesn't tap multiple times.
 *
 * @module components/review/ActionBar
 */

import React from 'react';
import { View, Text, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  ACTION_BG,
  ACTION_BORDER,
  COLOR_SURFACE_ALT,
  STATUS_COLOR,
} from './constants';
import type { ActionBarProps } from '@/types/review';

/**
 * Bottom action bar with three decision buttons.
 *
 * @param props - See `ActionBarProps`
 * @returns React element
 */
export function ActionBar({ isSubmitting, onDecision }: ActionBarProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 12,
        // WHY: iOS home-indicator inset — extra bottom padding prevents the
        // buttons from sitting directly under the system gesture bar.
        paddingBottom: Platform.OS === 'ios' ? 28 : 12,
        backgroundColor: COLOR_SURFACE_ALT,
        borderTopWidth: 1,
        borderTopColor: '#18181b',
        gap: 10,
      }}
    >
      <Pressable
        onPress={() => onDecision('rejected')}
        disabled={isSubmitting}
        style={{
          flex: 1,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: ACTION_BG.rejected,
          borderWidth: 1,
          borderColor: ACTION_BORDER.rejected,
          alignItems: 'center',
        }}
        accessibilityRole="button"
        accessibilityLabel="Reject changes"
      >
        <Text style={{ color: STATUS_COLOR.rejected, fontWeight: '700', fontSize: 14 }}>
          Reject
        </Text>
      </Pressable>

      <Pressable
        onPress={() => onDecision('changes_requested')}
        disabled={isSubmitting}
        style={{
          flex: 1,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: ACTION_BG.changes_requested,
          borderWidth: 1,
          borderColor: ACTION_BORDER.changes_requested,
          alignItems: 'center',
        }}
        accessibilityRole="button"
        accessibilityLabel="Request changes"
      >
        <Text style={{ color: STATUS_COLOR.changes_requested, fontWeight: '700', fontSize: 14 }}>
          Request Changes
        </Text>
      </Pressable>

      <Pressable
        onPress={() => onDecision('approved')}
        disabled={isSubmitting}
        style={{
          flex: 1,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: ACTION_BG.approved,
          borderWidth: 1,
          borderColor: ACTION_BORDER.approved,
          alignItems: 'center',
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 6,
        }}
        accessibilityRole="button"
        accessibilityLabel="Approve changes"
      >
        {isSubmitting ? (
          <ActivityIndicator size="small" color={STATUS_COLOR.approved} />
        ) : (
          <>
            <Ionicons name="checkmark" size={16} color={STATUS_COLOR.approved} />
            <Text style={{ color: STATUS_COLOR.approved, fontWeight: '700', fontSize: 14 }}>
              Approve
            </Text>
          </>
        )}
      </Pressable>
    </View>
  );
}
