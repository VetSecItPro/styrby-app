'use client';

/**
 * Encryption Transparency Section
 *
 * Plain-language explanation of Styrby's end-to-end encryption for
 * technically savvy developers who want to verify our claims.
 *
 * WHY static content:
 *   Encryption primitives don't change at runtime. This section is factual
 *   documentation of the implementation (migration 020 + PR #85) presented
 *   in the UI where users expect to find it.
 *
 * What it covers:
 *   1. The XChaCha20-Poly1305 symmetric cipher (libsodium)
 *   2. Per-device key derivation
 *   3. Key rotation story
 *   4. What is and is not encrypted
 *
 * @module privacy/EncryptionSection
 */

import { useState } from 'react';
import { Lock, ChevronDown, ChevronRight } from 'lucide-react';

interface FaqItem {
  question: string;
  answer: string;
}

const FAQ_ITEMS: FaqItem[] = [
  {
    question: 'What cipher is used?',
    answer:
      'Session message content is encrypted with XChaCha20-Poly1305 via libsodium (migration 020, PR #85). XChaCha20-Poly1305 provides authenticated encryption - it guarantees both confidentiality and integrity. A tampered ciphertext will fail decryption. The 192-bit nonce space makes nonce reuse statistically impossible even without strict counter management.',
  },
  {
    question: 'How are keys derived?',
    answer:
      'Each machine generates an asymmetric NaCl box keypair on first pair. The private key never leaves your machine - it is stored in the OS keychain (macOS Keychain / Linux Secret Service). The public key is uploaded to the machine_keys table so your phone can encrypt commands to your machine. Only your machine\'s private key can decrypt incoming commands.',
  },
  {
    question: 'What is encrypted vs plaintext?',
    answer:
      'Encrypted: session message content (your prompts, agent responses, tool results, permission request details). Plaintext: session metadata (title, project path, git branch, timestamps, token counts, costs). Metadata is kept plaintext so you can search and filter sessions without decrypting every message. Costs are never zero-knowledge - Styrby needs plaintext token counts to calculate costs.',
  },
  {
    question: 'Can Styrby read my session content?',
    answer:
      'No. Styrby\'s servers store ciphertext for session_messages. Without your device\'s private key, the content is unreadable. Supabase (our database provider) and Vercel (our web host) cannot decrypt your message content either. This is verifiable by inspecting the session_messages table - the content_encrypted column contains base64-encoded ciphertext.',
  },
  {
    question: 'What happens to encryption keys when I delete my account?',
    answer:
      'Your machine_keys rows are deleted as part of the account deletion cascade. The private keys stored on your machines remain on those machines - they are not backed up to Styrby servers. To fully purge all key material, run `styrby device remove` on each machine before deleting your account.',
  },
  {
    question: 'How do I rotate encryption keys?',
    answer:
      'Run `styrby device re-key` to generate a new keypair for your machine. The CLI will upload the new public key to machine_keys, re-encrypt pending outbound commands with the new key, and the old public key is replaced. Sessions already in Supabase remain encrypted under the old key - they are not re-encrypted (doing so would require the private key, which Styrby does not have).',
  },
  {
    question: 'Where can I verify the encryption implementation?',
    answer:
      'The encryption implementation is in packages/styrby-cli/src/modules/encryption.ts (libsodium, secretstream) and packages/styrby-shared/src/encryption.ts (key derivation helpers). Migration 020 (supabase/migrations/020_passkeys.sql) introduced the machine_keys table. The original implementation was shipped in PR #85.',
  },
];

function FaqRow({ item }: { item: FaqItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-zinc-800 last:border-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition-colors"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-zinc-500 flex-shrink-0 mt-0.5" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-500 flex-shrink-0 mt-0.5" aria-hidden />
        )}
        <span className="text-sm text-zinc-200">{item.question}</span>
      </button>

      {expanded && (
        <div className="px-11 pb-4">
          <p className="text-xs text-zinc-400 leading-relaxed">{item.answer}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the encryption transparency panel.
 */
export function EncryptionSection() {
  return (
    <section className="rounded-xl bg-zinc-900 border border-zinc-800">
      <div className="px-6 py-4 border-b border-zinc-800 flex items-center gap-3">
        <Lock className="h-4 w-4 text-yellow-400" aria-hidden />
        <h2 className="text-base font-semibold text-zinc-100">Encryption Details</h2>
        <span className="ml-auto text-xs text-zinc-500">For technical verification</span>
      </div>

      <div className="px-6 py-4 border-b border-zinc-800">
        <p className="text-sm text-zinc-400">
          Session message content is end-to-end encrypted. Styrby servers store
          ciphertext only - your device holds the private key. Expand any question below
          for technical details on the cryptographic primitives used.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-xs bg-yellow-500/10 text-yellow-300 px-2 py-1 rounded-full">XChaCha20-Poly1305</span>
          <span className="text-xs bg-yellow-500/10 text-yellow-300 px-2 py-1 rounded-full">libsodium secretstream</span>
          <span className="text-xs bg-yellow-500/10 text-yellow-300 px-2 py-1 rounded-full">NaCl box keypairs</span>
          <span className="text-xs bg-yellow-500/10 text-yellow-300 px-2 py-1 rounded-full">Per-device keys</span>
          <span className="text-xs bg-yellow-500/10 text-yellow-300 px-2 py-1 rounded-full">Zero server-side decryption</span>
        </div>
      </div>

      {FAQ_ITEMS.map((item) => (
        <FaqRow key={item.question} item={item} />
      ))}
    </section>
  );
}
