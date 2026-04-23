/**
 * CreateReplayLinkModal — Mobile (React Native / Expo)
 *
 * Native bottom sheet modal for generating a privacy-preserving session
 * replay link. Mirrors the web modal feature-for-feature (web-mobile parity
 * requirement from MEMORY.md).
 *
 * UX flow:
 *   1. User presses "Share session" in the session detail screen
 *   2. This modal slides up (Modal from React Native)
 *   3. User configures duration, max views, and scrub mask
 *   4. Presses "Generate link" -> POST /api/sessions/[id]/replay
 *   5. URL is shown with a one-tap copy button (Clipboard.setStringAsync)
 *   6. User can share via the native share sheet (Share.share)
 *
 * Security note (same as web):
 *   The raw token URL is shown ONCE. It is not persisted in AsyncStorage or
 *   any device cache. If the user closes without copying, they create a new token.
 *
 * @module components/replay/CreateReplayLinkModal
 */

import { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  Share,
  ActivityIndicator,
  Switch,
  Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type {
  ReplayTokenDuration,
  ReplayTokenMaxViews,
  ScrubMask,
  CreateReplayTokenResponse,
} from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the mobile CreateReplayLinkModal component.
 */
export interface CreateReplayLinkModalProps {
  /** Session ID to generate the replay link for. */
  sessionId: string;

  /** API base URL (from EXPO_PUBLIC_API_URL env var). */
  apiBaseUrl: string;

  /** Whether the modal is currently visible. */
  visible: boolean;

  /** Called when the user dismisses the modal. */
  onClose: () => void;
}

// ============================================================================
// Option data
// ============================================================================

const DURATION_OPTIONS: { value: ReplayTokenDuration; label: string }[] = [
  { value: '1h',  label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d',  label: '7 days' },
  { value: '30d', label: '30 days' },
];

const MAX_VIEWS_OPTIONS: { value: ReplayTokenMaxViews; label: string }[] = [
  { value: 1,           label: '1 view' },
  { value: 5,           label: '5 views' },
  { value: 10,          label: '10 views' },
  { value: 'unlimited', label: 'Unlimited' },
];

// ============================================================================
// Component
// ============================================================================

/**
 * Bottom sheet modal for creating a session replay token.
 *
 * @param props - CreateReplayLinkModalProps
 */
export function CreateReplayLinkModal({
  sessionId,
  apiBaseUrl,
  visible,
  onClose,
}: CreateReplayLinkModalProps) {
  // ── Form state ────────────────────────────────────────────────────────────
  const [duration, setDuration] = useState<ReplayTokenDuration>('24h');
  const [maxViews, setMaxViews] = useState<ReplayTokenMaxViews>(10);
  const [scrubMask, setScrubMask] = useState<ScrubMask>({
    secrets:    true,  // ON by default — API key leaks via replay are high-severity
    file_paths: false,
    commands:   false,
  });

  // ── UI state ──────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Generate ──────────────────────────────────────────────────────────────
  async function handleGenerate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration, maxViews, scrubMask }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? `Error ${res.status}`);
        return;
      }
      const data: CreateReplayTokenResponse = await res.json();
      setGeneratedUrl(data.url);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Copy ──────────────────────────────────────────────────────────────────
  async function handleCopy() {
    if (!generatedUrl) return;
    await Clipboard.setStringAsync(generatedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Native share sheet ────────────────────────────────────────────────────
  async function handleShare() {
    if (!generatedUrl) return;
    await Share.share({
      message: generatedUrl,
      title:   'Session Replay Link',
    });
  }

  // ── Close / reset ─────────────────────────────────────────────────────────
  function handleClose() {
    setGeneratedUrl(null);
    setError(null);
    onClose();
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={handleClose}
      accessible
      accessibilityViewIsModal
    >
      <View style={{ flex: 1, backgroundColor: '#09090b' }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingTop: Platform.OS === 'ios' ? 16 : 12,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: '#27272a',
          }}
        >
          <Text style={{ fontSize: 17, fontWeight: '600', color: '#fafafa' }}>
            Share session
          </Text>
          <Pressable
            onPress={handleClose}
            accessibilityLabel="Close modal"
            accessibilityRole="button"
            style={({ pressed }) => ({
              padding: 8,
              borderRadius: 8,
              backgroundColor: pressed ? '#27272a' : 'transparent',
            })}
          >
            <Text style={{ color: '#71717a', fontSize: 15 }}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20 }}>
          {!generatedUrl ? (
            <>
              {/* Duration */}
              <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                Expires after
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                {DURATION_OPTIONS.map(({ value, label }) => (
                  <Pressable
                    key={value}
                    onPress={() => setDuration(value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: duration === value }}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: duration === value ? '#7c3aed' : '#3f3f46',
                      backgroundColor: duration === value ? '#2e1065' : 'transparent',
                    }}
                  >
                    <Text style={{
                      fontSize: 14,
                      color: duration === value ? '#c4b5fd' : '#a1a1aa',
                      fontWeight: duration === value ? '600' : '400',
                    }}>
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Max views */}
              <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                Max views
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                {MAX_VIEWS_OPTIONS.map(({ value, label }) => (
                  <Pressable
                    key={String(value)}
                    onPress={() => setMaxViews(value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: maxViews === value }}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: maxViews === value ? '#7c3aed' : '#3f3f46',
                      backgroundColor: maxViews === value ? '#2e1065' : 'transparent',
                    }}
                  >
                    <Text style={{
                      fontSize: 14,
                      color: maxViews === value ? '#c4b5fd' : '#a1a1aa',
                      fontWeight: maxViews === value ? '600' : '400',
                    }}>
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Scrub mask */}
              <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>
                Privacy filter
              </Text>
              <Text style={{ color: '#52525b', fontSize: 13, marginBottom: 12 }}>
                Redact sensitive content before it reaches the viewer.
              </Text>
              {(
                [
                  { key: 'secrets' as const,    label: 'Secrets',        description: 'API keys, tokens, private keys' },
                  { key: 'file_paths' as const, label: 'File paths',     description: 'Absolute paths (basenames kept)' },
                  { key: 'commands' as const,   label: 'Shell commands', description: '$ prompts (structure kept)' },
                ] as const
              ).map(({ key, label, description }) => (
                <View
                  key={key}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: '#27272a',
                  }}
                >
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={{ color: '#fafafa', fontSize: 15, fontWeight: '500' }}>
                      {label}
                    </Text>
                    <Text style={{ color: '#71717a', fontSize: 13, marginTop: 2 }}>
                      {description}
                    </Text>
                  </View>
                  <Switch
                    value={scrubMask[key]}
                    onValueChange={(v) => setScrubMask((prev) => ({ ...prev, [key]: v }))}
                    trackColor={{ false: '#3f3f46', true: '#7c3aed' }}
                    thumbColor="#fafafa"
                    accessibilityLabel={`${label}: ${description}`}
                  />
                </View>
              ))}

              {error && (
                <Text style={{ color: '#f87171', fontSize: 13, marginTop: 12 }} accessibilityRole="alert">
                  {error}
                </Text>
              )}

              <Pressable
                onPress={handleGenerate}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Generate replay link"
                style={({ pressed }) => ({
                  marginTop: 24,
                  paddingVertical: 14,
                  borderRadius: 10,
                  backgroundColor: loading || pressed ? '#6d28d9' : '#7c3aed',
                  alignItems: 'center',
                  opacity: loading ? 0.7 : 1,
                })}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                    Generate link
                  </Text>
                )}
              </Pressable>
            </>
          ) : (
            /* Generated URL state */
            <View>
              <Text style={{ color: '#a1a1aa', fontSize: 14, marginBottom: 16, lineHeight: 20 }}>
                Your replay link is ready. This URL will not be shown again - copy or share it now.
              </Text>

              <View style={{
                backgroundColor: '#18181b',
                borderWidth: 1,
                borderColor: '#3f3f46',
                borderRadius: 10,
                padding: 14,
                marginBottom: 12,
              }}>
                <Text
                  style={{ color: '#a1a1aa', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', lineHeight: 18 }}
                  numberOfLines={3}
                  selectable
                >
                  {generatedUrl}
                </Text>
              </View>

              <Pressable
                onPress={handleCopy}
                accessibilityRole="button"
                accessibilityLabel="Copy replay link"
                style={({ pressed }) => ({
                  paddingVertical: 14,
                  borderRadius: 10,
                  backgroundColor: copied ? '#059669' : (pressed ? '#6d28d9' : '#7c3aed'),
                  alignItems: 'center',
                  marginBottom: 10,
                })}
              >
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                  {copied ? 'Copied!' : 'Copy link'}
                </Text>
              </Pressable>

              <Pressable
                onPress={handleShare}
                accessibilityRole="button"
                accessibilityLabel="Share replay link via native share sheet"
                style={({ pressed }) => ({
                  paddingVertical: 14,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: '#3f3f46',
                  backgroundColor: pressed ? '#27272a' : 'transparent',
                  alignItems: 'center',
                  marginBottom: 10,
                })}
              >
                <Text style={{ color: '#a1a1aa', fontSize: 16, fontWeight: '500' }}>
                  Share via...
                </Text>
              </Pressable>

              <Pressable
                onPress={handleClose}
                accessibilityRole="button"
                style={{ paddingVertical: 10, alignItems: 'center' }}
              >
                <Text style={{ color: '#71717a', fontSize: 14 }}>Done</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
