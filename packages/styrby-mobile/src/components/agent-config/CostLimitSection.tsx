/**
 * Agent Configuration — CostLimitSection
 *
 * Renders the "Cost Limit" group: a single decimal-pad text input prefixed
 * with `$` that bounds spend per session.
 *
 * WHY: Owns the input-sanitization rules (digits + single decimal) so the
 * orchestrator never has to think about character-class regex. Empty string
 * is preserved as the "unlimited" sentinel — saved as NULL in Supabase.
 */

import { View, Text, TextInput } from 'react-native';
import { SectionHeader } from './SectionHeader';

export interface CostLimitSectionProps {
  /** Controlled value of the cost-limit input (empty string = unlimited). */
  value: string;
  /** Setter that receives the sanitized numeric string. */
  onChange: (sanitized: string) => void;
}

/**
 * Sanitizes a cost-limit input string: keeps only digits and a single decimal.
 *
 * WHY: We sanitize on every keystroke so the field never holds an obviously
 * invalid string (e.g., "1.2.3" or "abc"). Final validation that the value
 * is a positive number happens at save time in the orchestrator.
 *
 * @param text - Raw text from the TextInput onChange callback.
 * @returns The sanitized numeric-only string.
 */
function sanitizeCost(text: string): string {
  const cleaned = text.replace(/[^0-9.]/g, '');
  // Prevent multiple decimal points
  const parts = cleaned.split('.');
  return parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : cleaned;
}

/**
 * Renders the Cost Limit section with `$` prefix and decimal-pad input.
 *
 * @param props - Section props.
 * @returns React element
 */
export function CostLimitSection({ value, onChange }: CostLimitSectionProps) {
  return (
    <>
      <SectionHeader title="Cost Limit" />
      <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden p-4">
        <Text className="text-zinc-500 text-sm mb-3">
          Maximum cost in USD before the agent pauses and asks for confirmation. Leave empty for no limit.
        </Text>
        <View className="flex-row items-center">
          <Text className="text-zinc-400 text-lg mr-2">$</Text>
          <TextInput
            className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2.5 text-sm"
            placeholder="e.g., 5.00"
            placeholderTextColor="#52525b"
            value={value}
            onChangeText={(text) => onChange(sanitizeCost(text))}
            keyboardType="decimal-pad"
            accessibilityLabel="Maximum cost per session in USD"
            accessibilityHint="Enter a dollar amount or leave empty for unlimited"
          />
        </View>
      </View>
    </>
  );
}
