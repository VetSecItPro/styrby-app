# Supabase Edge Functions

## Deploying Functions

### Prerequisites
1. Install Supabase CLI: `npm install -g supabase`
2. Login: `supabase login`
3. Link project: `supabase link --project-ref akmtmxunjhsgldjztdtt`

### Deploy All Functions
```bash
supabase functions deploy
```

### Deploy Single Function
```bash
supabase functions deploy polar-webhook
```

### Set Environment Variables
```bash
# Required for polar-webhook
supabase secrets set POLAR_WEBHOOK_SECRET=whsec_xxx
supabase secrets set POLAR_PRO_PRODUCT_ID=prod_xxx
supabase secrets set POLAR_POWER_PRODUCT_ID=prod_xxx
```

## Functions

### polar-webhook
Handles Polar subscription lifecycle events:
- `subscription.created` - Creates subscription record, updates user tier
- `subscription.updated` - Updates subscription status and period
- `subscription.canceled` - Marks subscription canceled, downgrades tier
- `order.created` - Logs payment to audit trail

**Endpoint:** `https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/polar-webhook`

**Configure in Polar Dashboard:**
1. Go to Settings → Webhooks → Create Webhook
2. URL: `https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/polar-webhook`
3. Events: `subscription.created`, `subscription.updated`, `subscription.canceled`, `order.created`
4. Copy the webhook secret and set it as `POLAR_WEBHOOK_SECRET`
