"use client"

import {
  CheckmarkCircle01Icon,
  InformationCircleIcon,
  Loading03Icon,
  CancelCircleIcon,
  AlertCircleIcon,
} from "@hugeicons/core-free-icons"
import { createIcon } from "@/components/ui/hugeicon"

const CircleCheckIcon = createIcon(CheckmarkCircle01Icon)
const InfoIcon = createIcon(InformationCircleIcon)
const Loader2Icon = createIcon(Loading03Icon)
const OctagonXIcon = createIcon(CancelCircleIcon)
const TriangleAlertIcon = createIcon(AlertCircleIcon)
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
