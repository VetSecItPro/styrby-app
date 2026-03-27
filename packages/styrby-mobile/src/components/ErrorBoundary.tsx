/**
 * ErrorBoundary Component
 *
 * A reusable React class-based error boundary for catching render-time errors
 * in child component trees. Displays a friendly fallback UI instead of a blank
 * or crashed screen, with a retry button to reset the error state.
 *
 * WHY a class component: React error boundaries MUST be class components because
 * the lifecycle methods componentDidCatch and getDerivedStateFromError are only
 * available on class components. Functional components cannot serve as error
 * boundaries as of React 18.
 *
 * WHY per-screen: Wrapping each screen in its own boundary means one tab
 * crashing does not take down the entire app. Users can still use other tabs
 * and the affected tab shows a recoverable error card instead of a blank screen.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// ============================================================================
// Types
// ============================================================================

/**
 * Props accepted by the ErrorBoundary component.
 */
interface ErrorBoundaryProps {
  /** The child component tree to monitor for errors. */
  children: React.ReactNode;
  /**
   * Optional custom fallback to render instead of the default error card.
   * Receives the caught error and a reset function.
   */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

/**
 * Internal state for the ErrorBoundary class component.
 */
interface ErrorBoundaryState {
  /** Whether an error has been caught from the child tree */
  hasError: boolean;
  /** The caught error instance, or null if no error */
  error: Error | null;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Route-level error boundary that catches unhandled render errors in children.
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary>
 *   <MyScreen />
 * </ErrorBoundary>
 * ```
 *
 * With custom fallback:
 * ```tsx
 * <ErrorBoundary fallback={(error, reset) => (
 *   <Text onPress={reset}>Custom error: {error.message}</Text>
 * )}>
 *   <MyScreen />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  /**
   * Updates state so the next render shows the fallback UI.
   * Called before render, so it can update state synchronously.
   *
   * @param error - The error that was caught
   * @returns Updated state to trigger the fallback render
   */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  /**
   * Called after an error has been thrown in a descendant component.
   * Used for logging — the actual UI update is handled by getDerivedStateFromError.
   *
   * @param error - The error that was caught
   * @param info - Component stack trace information
   */
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // WHY: Log in dev mode only to avoid noise in production. In production,
    // errors should be captured by an error monitoring service (e.g. Sentry).
    if (__DEV__) {
      console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
    }
  }

  /**
   * Resets the error state so the children can re-render.
   * Called when the user taps "Try Again" in the fallback UI.
   */
  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      const { fallback } = this.props;
      const { error } = this.state;

      // Use custom fallback if provided
      if (fallback && error) {
        return fallback(error, this.handleReset);
      }

      // Default fallback: branded error card with retry button
      return (
        <View className="flex-1 bg-background items-center justify-center px-6">
          <View className="bg-background-secondary rounded-2xl p-6 w-full items-center border border-zinc-800">
            {/* Error Icon */}
            <View className="w-14 h-14 rounded-full bg-red-500/10 items-center justify-center mb-4">
              <Ionicons name="warning-outline" size={28} color="#ef4444" />
            </View>

            {/* Title */}
            <Text className="text-white text-lg font-semibold mb-2 text-center">
              Something went wrong
            </Text>

            {/* Error message — show in dev, generic in prod */}
            <Text className="text-zinc-500 text-sm text-center mb-6">
              {__DEV__ && this.state.error
                ? this.state.error.message
                : 'An unexpected error occurred. Please try again.'}
            </Text>

            {/* Retry Button */}
            <Pressable
              onPress={this.handleReset}
              className="bg-brand px-6 py-3 rounded-xl active:opacity-80 w-full items-center"
              accessibilityRole="button"
              accessibilityLabel="Try again"
            >
              <Text className="text-white font-semibold">Try Again</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}
