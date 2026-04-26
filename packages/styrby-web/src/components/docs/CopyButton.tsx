"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * CopyButton — small accessible button that copies a string to the clipboard.
 *
 * Renders a Copy icon by default. On click, writes `text` to the clipboard,
 * swaps to a Check icon for ~2s, then reverts. Designed to be positioned
 * absolute top-right of a code block, but exported as an inline element so
 * callers control placement.
 *
 * @param text - The exact string to copy when the button is clicked
 * @param className - Optional class overrides for absolute positioning
 */
export function CopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  /**
   * Copies the prop `text` to the user's clipboard, surfaces a 2s visual
   * confirmation, and gracefully no-ops when the Clipboard API is unavailable
   * (older browsers / insecure contexts). Failures are logged to console
   * rather than thrown so the UI never crashes a docs page.
   */
  async function handleCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      // WHY: clipboard write can fail on permission denial; surface a console
      // warning rather than crashing the page render.
      console.warn("CopyButton: clipboard write failed", err);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied to clipboard" : "Copy code to clipboard"}
      className={
        className ??
        "absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      }
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}
