/**
 * Device pairing page - generates QR codes for mobile app pairing.
 *
 * Displays a QR code that the Styrby mobile app can scan to pair
 * with the user's account. Also shows a list of already paired devices.
 *
 * @route GET /devices/pair
 * @auth Required - redirects to /login if not authenticated
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PairingQR } from './pairing-qr';

/**
 * Renders the device pairing page with QR code and device list.
 */
export default async function PairDevicePage() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // Fetch user's existing machines
  const { data: machines } = await supabase
    .from('machines')
    .select('id, name, platform, is_online, last_seen_at, cli_version, hostname')
    .order('last_seen_at', { ascending: false });

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">S</span>
                </div>
                <span className="font-semibold text-zinc-100">Styrby</span>
              </Link>
            </div>

            <nav className="flex items-center gap-6">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Dashboard
              </Link>
              <Link
                href="/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link
                href="/costs"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Costs
              </Link>
              <Link
                href="/settings"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Settings
              </Link>
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-12">
        {/* Back link */}
        <Link
          href="/settings"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100 transition-colors mb-8"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back to Settings
        </Link>

        {/* Title */}
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">
          Pair New Device
        </h1>
        <p className="text-zinc-400 mb-8">
          Scan this QR code with the Styrby mobile app to connect a new machine
          to your account.
        </p>

        {/* QR Code component */}
        <PairingQR userId={user.id} />

        {/* Instructions */}
        <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">
            How to Pair
          </h2>
          <ol className="list-decimal list-inside space-y-3 text-zinc-400">
            <li>
              Open the Styrby app on your phone
            </li>
            <li>
              Tap <span className="text-zinc-100">&quot;Add Machine&quot;</span> or the{' '}
              <span className="text-zinc-100">+</span> button
            </li>
            <li>
              Point your camera at the QR code above
            </li>
            <li>
              Confirm the pairing on your phone
            </li>
          </ol>
        </div>

        {/* Paired devices */}
        {machines && machines.length > 0 && (
          <div className="mt-12">
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">
              Paired Devices ({machines.length})
            </h2>
            <div className="space-y-3">
              {machines.map((machine) => (
                <div
                  key={machine.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
                >
                  <div className="flex items-center gap-4">
                    {/* Platform icon */}
                    <div className="h-10 w-10 rounded-lg bg-zinc-800 flex items-center justify-center">
                      {machine.platform === 'darwin' ? (
                        <svg
                          className="h-5 w-5 text-zinc-400"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
                        </svg>
                      ) : machine.platform === 'linux' ? (
                        <svg
                          className="h-5 w-5 text-zinc-400"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587.006 1.22-.057 1.863-.25.643-.192 1.283-.465 1.852-.9.249.174.462.423.611.725.196.4.48.725.834.935.349.21.753.276 1.137.187.384-.09.735-.318 1.006-.674.543.042 1.092-.104 1.554-.415.462-.31.85-.805 1.063-1.455a2.22 2.22 0 00-.001-1.23c-.088-.27-.234-.52-.415-.74.08-.103.156-.21.224-.315.262-.397.428-.823.445-1.21.046-.537-.067-1.06-.376-1.527-.177-.272-.41-.513-.682-.715a.946.946 0 00-.179-.296c-.04-.06-.08-.11-.117-.157-.156-.186-.34-.43-.582-.622-.245-.195-.536-.348-.87-.451-.35-.11-.77-.184-1.236-.22a.953.953 0 00-.212-.016l-.037-.002c-.284-.024-.543-.097-.758-.226-.215-.128-.385-.303-.507-.524-.122-.22-.196-.476-.236-.767-.04-.29-.046-.612-.016-.96.027-.306.05-.62.035-.947-.02-.426-.124-.867-.32-1.32-.195-.453-.495-.913-.87-1.379-.373-.466-.83-.942-1.334-1.434-.17-.167-.346-.336-.524-.509-.175-.17-.351-.343-.528-.521-.095-.092-.19-.184-.287-.277-.097-.093-.19-.185-.284-.28-.093-.093-.186-.188-.282-.282-.09-.1-.18-.196-.273-.293-.092-.097-.184-.195-.276-.293-.09-.097-.182-.194-.275-.292l-.275-.294c-.09-.094-.182-.191-.273-.286-.09-.096-.178-.19-.27-.284" />
                        </svg>
                      ) : (
                        <svg
                          className="h-5 w-5 text-zinc-400"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
                        </svg>
                      )}
                    </div>

                    {/* Machine info */}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">
                          {machine.name}
                        </span>
                        {machine.is_online && (
                          <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                        )}
                      </div>
                      <div className="text-sm text-zinc-500">
                        {machine.hostname && (
                          <span className="mr-2">{machine.hostname}</span>
                        )}
                        {machine.cli_version && (
                          <span className="text-zinc-600">
                            v{machine.cli_version}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Last seen */}
                  <div className="text-sm text-zinc-500">
                    {machine.is_online ? (
                      <span className="text-green-500">Online</span>
                    ) : (
                      <span>
                        Last seen{' '}
                        {machine.last_seen_at
                          ? new Date(machine.last_seen_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })
                          : 'never'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No devices message */}
        {(!machines || machines.length === 0) && (
          <div className="mt-12 text-center text-zinc-500">
            <p>No devices paired yet. Scan the QR code above to get started.</p>
          </div>
        )}
      </main>
    </div>
  );
}
