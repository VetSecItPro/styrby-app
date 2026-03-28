import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DocNavItem } from "./nav";

/**
 * Previous/Next navigation links rendered at the bottom of each doc page.
 *
 * @param prev - The previous page in the docs nav, or null
 * @param next - The next page in the docs nav, or null
 */
export function PrevNext({
  prev,
  next,
}: {
  prev: DocNavItem | null;
  next: DocNavItem | null;
}) {
  return (
    <div className="mt-16 flex items-center justify-between border-t border-zinc-800 pt-6">
      {prev ? (
        <Link
          href={prev.href}
          className="group flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-amber-500"
        >
          <ChevronLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
          {prev.title}
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-amber-500"
        >
          {next.title}
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}
