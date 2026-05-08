/**
 * Webhooks-specific re-export of the generic PowerTierGate.
 *
 * Kept as a thin wrapper so existing `import { PowerTierGate } from
 * '../src/components/webhooks'` paths keep working after the consolidation.
 * The generic component now lives at `src/components/tier/PowerTierGate.tsx`.
 */

import { PowerTierGate as GenericPowerTierGate } from '../tier/PowerTierGate';

/**
 * Webhooks-tier gate. Pre-configured with the feature name + description for
 * the Webhooks screen so existing call sites (`<PowerTierGate />`) keep
 * rendering the same content they always did.
 *
 * For new screens, prefer importing the generic component directly from
 * `src/components/tier/PowerTierGate` and passing your own props.
 *
 * @returns React element
 */
export function PowerTierGate() {
  return (
    <GenericPowerTierGate
      feature="Webhooks"
      description="Automate your workflow by receiving real-time event notifications to any HTTPS endpoint."
      icon="key"
    />
  );
}
