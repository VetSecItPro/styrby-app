/**
 * ReviewHeader — Top bar with back button, title, summary, and status badge.
 *
 * The status badge only renders for non-pending reviews so the header stays
 * uncluttered while a decision is still in flight.
 *
 * @module components/review/ReviewHeader
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLOR_MUTED, STATUS_BG, STATUS_COLOR, STATUS_LABEL } from './constants';
import type { ReviewHeaderProps } from '@/types/review';

/**
 * Renders the screen header with navigation back button and a status pill
 * once a decision has been recorded.
 *
 * @param props - See `ReviewHeaderProps`
 * @returns React element
 */
export function ReviewHeader({ summary, status, isDecided, onBack }: ReviewHeaderProps) {
  // WHY: STATUS_* tables are keyed on non-pending statuses only — guarding here
  // (rather than at lookup) keeps the type narrow when accessing the maps.
  const decisionStatus = isDecided && status !== 'pending' ? status : null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#18181b',
      }}
    >
      <Pressable
        onPress={onBack}
        style={{ padding: 4, marginRight: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="arrow-back" size={22} color={COLOR_MUTED} />
      </Pressable>

      <View style={{ flex: 1 }}>
        <Text style={{ color: 'white', fontWeight: '700', fontSize: 16 }}>Code Review</Text>
        {summary && (
          <Text style={{ color: COLOR_MUTED, fontSize: 13 }} numberOfLines={1}>
            {summary}
          </Text>
        )}
      </View>

      {decisionStatus && (
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            backgroundColor: STATUS_BG[decisionStatus],
          }}
        >
          <Text
            style={{
              fontWeight: '700',
              fontSize: 12,
              color: STATUS_COLOR[decisionStatus],
            }}
          >
            {STATUS_LABEL[decisionStatus]}
          </Text>
        </View>
      )}
    </View>
  );
}
