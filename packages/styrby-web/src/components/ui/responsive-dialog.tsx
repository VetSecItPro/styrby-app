'use client'

/**
 * Responsive Dialog Component
 *
 * Renders a centered Dialog on desktop (md+) and a bottom-sheet Drawer on mobile.
 * Drop-in replacement for Dialog — same API, automatically adapts to viewport.
 *
 * WHY: Centered modals feel cramped on 375px screens. Bottom sheets feel native
 * on mobile and match iOS/Android patterns that users are trained on.
 *
 * @module components/ui/responsive-dialog
 */

import * as React from 'react'
import { useIsMobile } from '@/components/ui/use-mobile'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'

/**
 * Props for the ResponsiveDialog root component.
 *
 * @param children - Dialog content
 * @param open - Controlled open state
 * @param onOpenChange - Callback when open state changes
 */
interface ResponsiveDialogProps {
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * Root component — renders Dialog on desktop, Drawer on mobile.
 */
function ResponsiveDialog({ children, ...props }: ResponsiveDialogProps) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <Drawer {...props}>{children}</Drawer>
  }

  return <Dialog {...props}>{children}</Dialog>
}

/**
 * Trigger — opens the dialog/drawer.
 */
function ResponsiveDialogTrigger({
  children,
  ...props
}: React.ComponentProps<typeof DialogTrigger>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <DrawerTrigger {...props}>{children}</DrawerTrigger>
  }

  return <DialogTrigger {...props}>{children}</DialogTrigger>
}

/**
 * Content — the modal body. Drawer version slides up from bottom.
 */
function ResponsiveDialogContent({
  children,
  className,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <DrawerContent className={className}>
        {children}
      </DrawerContent>
    )
  }

  return (
    <DialogContent className={className} {...props}>
      {children}
    </DialogContent>
  )
}

/**
 * Header — title area.
 */
function ResponsiveDialogHeader({
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <DrawerHeader {...props}>{children}</DrawerHeader>
  }

  return <DialogHeader {...props}>{children}</DialogHeader>
}

/**
 * Footer — action buttons area.
 */
function ResponsiveDialogFooter({
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <DrawerFooter {...props}>{children}</DrawerFooter>
  }

  return <DialogFooter {...props}>{children}</DialogFooter>
}

/**
 * Title — the dialog heading.
 */
function ResponsiveDialogTitle({
  children,
  ...props
}: React.ComponentProps<typeof DialogTitle>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <DrawerTitle {...props}>{children}</DrawerTitle>
  }

  return <DialogTitle {...props}>{children}</DialogTitle>
}

/**
 * Description — subtitle text below the title.
 */
function ResponsiveDialogDescription({
  children,
  ...props
}: React.ComponentProps<typeof DialogDescription>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <DrawerDescription {...props}>{children}</DrawerDescription>
  }

  return <DialogDescription {...props}>{children}</DialogDescription>
}

/**
 * Close — the close button/trigger.
 */
function ResponsiveDialogClose({
  children,
  ...props
}: React.ComponentProps<typeof DialogClose>) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <DrawerClose {...props}>{children}</DrawerClose>
  }

  return <DialogClose {...props}>{children}</DialogClose>
}

export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogClose,
}
