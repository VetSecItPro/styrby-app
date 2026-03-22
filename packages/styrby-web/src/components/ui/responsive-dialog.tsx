'use client'

/**
 * Responsive Dialog Component
 *
 * Renders a centered Dialog on desktop (md+) and a bottom-sheet Drawer on mobile.
 * Drop-in replacement for Dialog. Automatically adapts to viewport.
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

interface ResponsiveDialogProps {
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function ResponsiveDialog({ children, ...props }: ResponsiveDialogProps) {
  const isMobile = useIsMobile()
  if (isMobile) return <Drawer {...props}>{children}</Drawer>
  return <Dialog {...props}>{children}</Dialog>
}

function ResponsiveDialogTrigger({ children, ...props }: { children: React.ReactNode; asChild?: boolean; className?: string }) {
  const isMobile = useIsMobile()
  if (isMobile) return <DrawerTrigger asChild={props.asChild} className={props.className}>{children}</DrawerTrigger>
  return <DialogTrigger asChild={props.asChild} className={props.className}>{children}</DialogTrigger>
}

function ResponsiveDialogContent({ children, className }: { children: React.ReactNode; className?: string }) {
  const isMobile = useIsMobile()
  if (isMobile) return <DrawerContent className={className}>{children}</DrawerContent>
  return <DialogContent className={className}>{children}</DialogContent>
}

function ResponsiveDialogHeader({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useIsMobile()
  if (isMobile) return <DrawerHeader {...props}>{children}</DrawerHeader>
  return <DialogHeader {...props}>{children}</DialogHeader>
}

function ResponsiveDialogFooter({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useIsMobile()
  if (isMobile) return <DrawerFooter {...props}>{children}</DrawerFooter>
  return <DialogFooter {...props}>{children}</DialogFooter>
}

function ResponsiveDialogTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  const isMobile = useIsMobile()
  if (isMobile) return <DrawerTitle className={className}>{children}</DrawerTitle>
  return <DialogTitle className={className}>{children}</DialogTitle>
}

function ResponsiveDialogDescription({ children, className }: { children: React.ReactNode; className?: string }) {
  const isMobile = useIsMobile()
  if (isMobile) return <DrawerDescription className={className}>{children}</DrawerDescription>
  return <DialogDescription className={className}>{children}</DialogDescription>
}

function ResponsiveDialogClose({ children, className }: { children?: React.ReactNode; className?: string }) {
  const isMobile = useIsMobile()
  if (isMobile) return <DrawerClose className={className}>{children}</DrawerClose>
  return <DialogClose className={className}>{children}</DialogClose>
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
