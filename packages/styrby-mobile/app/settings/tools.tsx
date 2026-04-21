/**
 * MCP Tools Settings Sub-Screen
 *
 * Mobile mirror of the web /dashboard/tools registry. Shows the Styrby MCP
 * tool catalog so users on mobile can see what their agents can call back
 * into Styrby for, and copy the .mcp.json snippet to set it up on their
 * desktop CLI.
 *
 * Pure presentation — reads the static catalog from styrby-shared. No
 * fetches, no auth checks beyond the settings stack that wraps it.
 *
 * @see app/settings/_layout.tsx
 * @see packages/styrby-web/src/app/dashboard/tools/tools-registry.tsx (web mirror)
 * @module app/settings/tools
 */

import {
  View,
  Text,
  Pressable,
  ScrollView,
  Alert,
  Linking,
} from 'react-native';
import { useState } from 'react';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import {
  STYRBY_MCP_TOOLS,
  type MCPToolDescriptor,
  type MCPToolStatus,
} from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/**
 * Verbatim .mcp.json snippet for copy-to-clipboard. Identical to the web
 * version - changing one without the other is a documentation bug.
 */
const SETUP_SNIPPET = `{
  "mcpServers": {
    "styrby": {
      "command": "styrby",
      "args": ["mcp", "serve"]
    }
  }
}`;

const STATUS_LABEL: Record<MCPToolStatus, string> = {
  ga: 'Available',
  beta: 'Beta',
  planned: 'Coming soon',
};

const STATUS_COLOR: Record<MCPToolStatus, string> = {
  ga: '#22c55e',
  beta: '#f59e0b',
  planned: '#71717a',
};

/**
 * Lucide-equivalent Ionicons for each tool category.
 * Keep in sync with web's CATEGORY_ICON map.
 */
const CATEGORY_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  approval: 'key-outline',
  policy: 'shield-checkmark-outline',
  audit: 'document-text-outline',
  query: 'server-outline',
  mutation: 'flash-outline',
};

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Single tool row with icon, title, status badge, and description.
 */
function ToolRow({ tool }: { tool: MCPToolDescriptor }) {
  const isAvailable = tool.status === 'ga' || tool.status === 'beta';
  const iconName = CATEGORY_ICON[tool.category] ?? 'extension-puzzle-outline';

  return (
    <View
      className={`bg-zinc-900 rounded-xl p-4 mb-3 border ${
        isAvailable ? 'border-zinc-700' : 'border-zinc-800 opacity-60'
      }`}
    >
      <View className="flex-row items-start">
        <View
          className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${
            isAvailable ? 'bg-amber-500/10' : 'bg-zinc-500/10'
          }`}
        >
          <Ionicons
            name={iconName}
            size={20}
            color={isAvailable ? '#f59e0b' : '#71717a'}
          />
        </View>

        <View className="flex-1 min-w-0">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-white text-sm font-semibold flex-1" numberOfLines={1}>
              {tool.title}
            </Text>
            <View
              className="px-2 py-0.5 rounded-full"
              style={{ backgroundColor: `${STATUS_COLOR[tool.status]}20` }}
            >
              <Text
                className="text-xs"
                style={{ color: STATUS_COLOR[tool.status] }}
              >
                {STATUS_LABEL[tool.status]}
              </Text>
            </View>
          </View>

          <Text className="text-zinc-500 text-xs mt-0.5 font-mono">{tool.name}</Text>

          <Text className="text-zinc-400 text-sm mt-2 leading-5">
            {tool.description}
          </Text>

          <Text className="text-zinc-600 text-xs mt-2">
            Introduced in v{tool.introducedIn}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Scrollable code block + copy button for the setup snippet.
 *
 * WHY a horizontal ScrollView wrapper around the <Text>: the snippet is
 * wider than narrow phone widths. A ScrollView lets the user pan to see
 * the rest without text-wrap reformatting the JSON.
 */
function SetupSnippetBlock() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await Clipboard.setStringAsync(SETUP_SNIPPET);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      Alert.alert('Copy failed', 'Could not copy to clipboard.');
    }
  }

  return (
    <View className="bg-zinc-900 rounded-xl border border-zinc-700 overflow-hidden mb-6">
      <View className="flex-row items-center justify-between px-4 py-2 border-b border-zinc-800">
        <Text className="text-zinc-500 text-xs font-mono">.mcp.json</Text>
        <Pressable
          onPress={handleCopy}
          className="flex-row items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800"
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied to clipboard' : 'Copy setup snippet'}
        >
          {copied ? (
            <>
              <Ionicons name="checkmark" size={14} color="#22c55e" />
              <Text className="text-green-400 text-xs">Copied</Text>
            </>
          ) : (
            <>
              <Ionicons name="copy-outline" size={14} color="#a1a1aa" />
              <Text className="text-zinc-400 text-xs">Copy</Text>
            </>
          )}
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="p-4">
        <Text className="text-zinc-200 text-xs font-mono">{SETUP_SNIPPET}</Text>
      </ScrollView>
    </View>
  );
}

// ============================================================================
// Main screen
// ============================================================================

/**
 * MCPToolsScreen — settings sub-screen for the MCP tool catalog.
 */
export default function MCPToolsScreen() {
  const gaTools = STYRBY_MCP_TOOLS.filter(
    (t) => t.status === 'ga' || t.status === 'beta',
  );
  const plannedTools = STYRBY_MCP_TOOLS.filter((t) => t.status === 'planned');

  return (
    <>
      <Stack.Screen options={{ title: 'MCP Tools' }} />

      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ padding: 16 }}
      >
        {/* Intro */}
        <Text className="text-zinc-400 text-sm mb-6 leading-5">
          The Model Context Protocol lets your coding agents call back into
          Styrby for capabilities only Styrby has - like asking your phone
          for approval before running a destructive command.
        </Text>

        {/* Setup snippet */}
        <Text className="text-zinc-500 text-xs font-medium uppercase tracking-wide mb-2">
          1. Wire it up on your desktop
        </Text>
        <Text className="text-zinc-500 text-xs mb-3">
          Add this to your agent&apos;s .mcp.json (Claude Code, Cursor, etc.).
        </Text>
        <SetupSnippetBlock />

        {/* Available tools */}
        <Text className="text-zinc-500 text-xs font-medium uppercase tracking-wide mb-3">
          2. Available tools ({gaTools.length})
        </Text>
        {gaTools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} />
        ))}

        {/* Planned tools */}
        {plannedTools.length > 0 && (
          <View className="mt-4">
            <Text className="text-zinc-500 text-xs font-medium uppercase tracking-wide mb-3">
              3. Planned ({plannedTools.length})
            </Text>
            {plannedTools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} />
            ))}
          </View>
        )}

        {/* External docs link */}
        <Pressable
          onPress={() => Linking.openURL('https://modelcontextprotocol.io')}
          className="flex-row items-center justify-center mt-6 mb-2 py-2"
          accessibilityRole="link"
          accessibilityLabel="Learn about Model Context Protocol"
        >
          <Text className="text-zinc-500 text-xs mr-1">
            Learn about Model Context Protocol
          </Text>
          <Ionicons name="open-outline" size={12} color="#71717a" />
        </Pressable>
      </ScrollView>
    </>
  );
}
