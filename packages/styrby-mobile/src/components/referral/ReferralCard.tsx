/**
 * ReferralCard
 *
 * Mobile UI component for the "Invite a friend" section in Settings.
 *
 * Displays the user's referral code with copy-to-clipboard and native share
 * sheet functionality. Shows a transient "Copied!" confirmation after copy.
 *
 * WHY expo-clipboard: Cross-platform clipboard API for Expo managed workflow.
 * WHY React Native Share.share(): Triggers the native OS share sheet — lets
 * users send their referral link via SMS, iMessage, Twitter, etc. without us
 * needing to integrate any specific social sharing SDK.
 *
 * WHY Ionicons: @expo/vector-icons Ionicons is the established icon set
 * in styrby-mobile. lucide-react-native is not installed.
 *
 * @param referralCode - The user's referral code (e.g. "ALICE123")
 * @param displayName - The user's display name for the share message
 */

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Share, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';

const APP_BASE_URL = 'https://styrbyapp.com';

interface ReferralCardProps {
  referralCode: string;
  displayName?: string;
}

/**
 * Invite-a-friend card for the mobile Settings screen.
 *
 * @param referralCode - User's unique referral code
 * @param displayName - User's display name for share message copy
 */
export default function ReferralCard({ referralCode, displayName }: ReferralCardProps) {
  const [copied, setCopied] = useState(false);

  const referralUrl = `${APP_BASE_URL}/r/${referralCode}`;
  const shareMessage = displayName
    ? `${displayName} invited you to Styrby - the AI coding dashboard. Use my referral link to get started: ${referralUrl}`
    : `Join Styrby - the AI coding dashboard. Use my referral link: ${referralUrl}`;

  /**
   * Copy the referral URL to the clipboard.
   * Shows a brief "Copied!" confirmation that resets after 2 seconds.
   */
  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(referralUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [referralUrl]);

  /**
   * Open the native share sheet with the referral message.
   */
  const handleShare = useCallback(async () => {
    try {
      await Share.share({
        message: shareMessage,
        url: referralUrl,
        title: 'Join me on Styrby',
      });
    } catch {
      // User cancelled share or share failed - no action needed
    }
  }, [shareMessage, referralUrl]);

  return (
    <View style={styles.card} accessibilityRole="none">
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.iconWrap}>
          <Ionicons name="gift-outline" size={20} color="#f59e0b" />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Invite a friend</Text>
          <Text style={styles.subtitle}>
            Share your link and earn a free month when they upgrade
          </Text>
        </View>
      </View>

      {/* Referral code display */}
      <View style={styles.codeRow}>
        <Text style={styles.codeLabel}>Your referral link</Text>
        <TouchableOpacity
          style={styles.codeBox}
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={`Copy referral link: ${referralUrl}`}
          accessibilityHint="Double tap to copy your referral link to the clipboard"
        >
          <Text style={styles.codeText} numberOfLines={1}>
            {APP_BASE_URL}/r/{referralCode}
          </Text>
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={16}
            color={copied ? '#22c55e' : '#9ca3af'}
          />
        </TouchableOpacity>
        {copied ? (
          <Text
            style={styles.copiedHint}
            accessibilityLiveRegion="polite"
          >
            Copied to clipboard!
          </Text>
        ) : null}
      </View>

      {/* Action buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.buttonSecondary]}
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel="Copy link"
        >
          <Ionicons name="copy-outline" size={16} color="#9ca3af" />
          <Text style={styles.buttonSecondaryText}>{copied ? 'Copied!' : 'Copy link'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary]}
          onPress={handleShare}
          accessibilityRole="button"
          accessibilityLabel="Share referral link"
        >
          <Ionicons name="share-outline" size={16} color="#18181b" />
          <Text style={styles.buttonPrimaryText}>Share</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 20,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(245,158,11,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f9fafb',
  },
  subtitle: {
    fontSize: 13,
    color: '#6b7280',
    lineHeight: 18,
  },
  codeRow: {
    gap: 6,
  },
  codeLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#4b5563',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  codeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  codeText: {
    flex: 1,
    fontSize: 13,
    color: '#d1d5db',
    fontFamily: 'monospace',
  },
  copiedHint: {
    fontSize: 12,
    color: '#22c55e',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
  },
  buttonSecondary: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  buttonSecondaryText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#9ca3af',
  },
  buttonPrimary: {
    backgroundColor: '#f59e0b',
  },
  buttonPrimaryText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#18181b',
  },
});
