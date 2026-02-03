/**
 * Root Layout
 *
 * Sets up the navigation stack, auth state, and global providers.
 */

import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from '../src/lib/supabase';
import type { Session } from '@supabase/supabase-js';

import '../global.css';

// Prevent auto-hide splash screen
SplashScreen.preventAutoHideAsync();

const ONBOARDING_KEY = 'styrby_onboarded';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const [session, setSession] = useState<Session | null>(null);
  const [hasOnboarded, setHasOnboarded] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check auth state and onboarding status
  useEffect(() => {
    const initialize = async () => {
      try {
        // Check onboarding status
        const onboarded = await SecureStore.getItemAsync(ONBOARDING_KEY);
        setHasOnboarded(onboarded === 'true');

        // Get current session
        const { data: { session } } = await supabase.auth.getSession();
        setSession(session);
      } catch (error) {
        console.error('Initialization error:', error);
      } finally {
        setIsLoading(false);
        SplashScreen.hideAsync();
      }
    };

    initialize();

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Handle routing based on auth state
  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inOnboarding = segments[0] === 'onboarding';
    const inTabs = segments[0] === '(tabs)';

    // Not onboarded → show onboarding
    if (!hasOnboarded && !inOnboarding) {
      router.replace('/onboarding');
      return;
    }

    // Onboarded but not logged in → show login (unless already in auth)
    if (hasOnboarded && !session && !inAuthGroup) {
      router.replace('/(auth)/login');
      return;
    }

    // Logged in → go to tabs (unless already there)
    if (session && !inTabs && !inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [session, hasOnboarded, segments, isLoading, router]);

  // Mark onboarding complete
  useEffect(() => {
    const markOnboarded = async () => {
      if (session && !hasOnboarded) {
        await SecureStore.setItemAsync(ONBOARDING_KEY, 'true');
        setHasOnboarded(true);
      }
    };
    markOnboarded();
  }, [session, hasOnboarded]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#09090b' },
          headerTintColor: '#fff',
          contentStyle: { backgroundColor: '#09090b' },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen
          name="onboarding"
          options={{
            headerShown: false,
            gestureEnabled: false,
          }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
