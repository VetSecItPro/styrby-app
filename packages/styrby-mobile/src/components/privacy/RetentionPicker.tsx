/**
 * Mobile Retention Picker
 *
 * Renders a segmented list of retention options the user can tap to set their
 * global session auto-delete window. Backed by PUT /api/account/retention.
 *
 * WHY a picker (not a modal): retention changes are low-stakes and frequent
 * enough that a full modal would be heavyweight. A radio-button-style list
 * matches the iOS/Android settings convention for single-choice options.
 *
 * GDPR Art. 5(1)(e) — storage limitation principle.
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { getApiBaseUrl } from '@/lib/config';
import { SectionHeader } from '@/components/ui';

/** Retention options displayed to the user. */
const RETENTION_OPTIONS: { label: string; value: number | null; description: string }[] = [
  { label: '7 days', value: 7, description: 'Privacy-first' },
  { label: '30 days', value: 30, description: 'Recommended' },
  { label: '90 days', value: 90, description: '' },
  { label: '1 year', value: 365, description: '' },
  { label: 'Never', value: null, description: 'Manual only' },
];

/** Props for {@link RetentionPicker}. */
export interface RetentionPickerProps {
  /**
   * Current retention setting from the server.
   * 'loading' = still fetching; null = never delete.
   */
  initialRetentionDays: number | null | 'loading';
  /** Called after a successful API update */
  onRetentionChanged: (newValue: number | null) => void;
  /** User ID — retained for audit correlation */
  userId: string;
}

/**
 * Segmented retention window picker with optimistic UI.
 *
 * @param props - Retention state + callback
 */
export function RetentionPicker({
  initialRetentionDays,
  onRetentionChanged,
}: RetentionPickerProps) {
  const [selected, setSelected] = useState<number | null>(
    initialRetentionDays === 'loading' ? null : initialRetentionDays,
  );
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync when the parent resolves the initial value
  // (we check the prop but don't create a useEffect race — one-time sync)
  const resolvedInitial = initialRetentionDays === 'loading' ? null : initialRetentionDays;
  if (resolvedInitial !== selected && !isUpdating && initialRetentionDays !== 'loading') {
    setSelected(resolvedInitial);
  }

  const handleSelect = useCallback(async (value: number | null) => {
    const previous = selected;
    setSelected(value);
    setIsUpdating(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setSelected(previous);
        setError('Not signed in. Please sign in and try again.');
        return;
      }

      const response = await fetch(`${getApiBaseUrl()}/api/account/retention`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ retention_days: value }),
      });

      if (!response.ok) {
        const data = await response.json();
        setSelected(previous);
        setError(data.error ?? 'Failed to update. Please try again.');
        return;
      }

      onRetentionChanged(value);
    } catch {
      setSelected(previous);
      setError('Network error. Please check your connection.');
    } finally {
      setIsUpdating(false);
    }
  }, [selected, onRetentionChanged]);

  return (
    <>
      <SectionHeader title="Session Retention" />
      <View className="bg-background-secondary mx-4 rounded-xl mb-4 overflow-hidden">
        {initialRetentionDays === 'loading' ? (
          <View className="py-6 items-center">
            <ActivityIndicator size="small" color="#71717a" />
          </View>
        ) : (
          <>
            {RETENTION_OPTIONS.map((option, index) => {
              const isSelected = selected === option.value;
              const isLast = index === RETENTION_OPTIONS.length - 1;

              return (
                <Pressable
                  key={String(option.value)}
                  onPress={() => handleSelect(option.value)}
                  disabled={isUpdating}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={`${option.label} retention${option.description ? ' - ' + option.description : ''}`}
                  className={`flex-row items-center px-4 py-3 active:bg-zinc-800 ${
                    !isLast ? 'border-b border-zinc-800' : ''
                  }`}
                >
                  <View
                    className={`h-5 w-5 rounded-full border-2 mr-3 items-center justify-center ${
                      isSelected ? 'border-blue-400 bg-blue-400' : 'border-zinc-600'
                    }`}
                    aria-hidden
                  >
                    {isSelected && (
                      <View className="h-2 w-2 rounded-full bg-white" />
                    )}
                  </View>
                  <View className="flex-1">
                    <Text className={`text-sm font-medium ${isSelected ? 'text-blue-300' : 'text-zinc-200'}`}>
                      {option.label}
                    </Text>
                    {option.description ? (
                      <Text className="text-xs text-zinc-500">{option.description}</Text>
                    ) : null}
                  </View>
                  {isUpdating && isSelected && (
                    <ActivityIndicator size="small" color="#3b82f6" />
                  )}
                  {isSelected && !isUpdating && (
                    <Ionicons name="checkmark" size={16} color="#3b82f6" />
                  )}
                </Pressable>
              );
            })}
          </>
        )}
      </View>

      {error && (
        <Text
          role="alert"
          className="text-xs text-red-400 mx-4 mb-2 -mt-2"
        >
          {error}
        </Text>
      )}

      <Text className="text-xs text-zinc-500 mx-4 mb-4">
        Auto-delete sessions older than the selected window. Individual sessions can
        be pinned to override this setting.
      </Text>
    </>
  );
}
