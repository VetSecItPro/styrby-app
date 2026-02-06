import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SettingsClient } from './settings-client';

/**
 * Settings page - user preferences and account settings.
 *
 * Server component that fetches user data, profile, subscription,
 * notification preferences, and agent configs. Delegates all interactive
 * functionality to the SettingsClient client component.
 *
 * NOTE: Navigation chrome (sidebar, topnav) is handled by dashboard/layout.tsx.
 */
export default async function SettingsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch user profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  // Fetch subscription
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // Fetch notification preferences
  const { data: notificationPrefs } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // Fetch agent configs
  const { data: agentConfigs } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('user_id', user.id);

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-8">Settings</h1>

      <SettingsClient
        user={{
          email: user.email || '',
          provider: user.app_metadata?.provider,
        }}
        profile={profile}
        subscription={subscription}
        notificationPrefs={notificationPrefs}
        agentConfigs={agentConfigs}
      />
    </div>
  );
}
