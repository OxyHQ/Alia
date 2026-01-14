import * as React from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

const Field = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }>(
  ({ className, orientation = "vertical", ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex gap-2", orientation === "vertical" ? "flex-col" : "flex-row items-center", className)}
      {...props}
    />
  )
)
Field.displayName = "Field"

const FieldGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("space-y-4", className)} {...props} />
  )
)
FieldGroup.displayName = "FieldGroup"

const FieldLabel = React.forwardRef<React.ElementRef<typeof Label>, React.ComponentPropsWithoutRef<typeof Label>>(
  ({ className, ...props }, ref) => (
    <Label ref={ref} className={cn("", className)} {...props} />
  )
)
FieldLabel.displayName = "FieldLabel"

const FieldDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
)
FieldDescription.displayName = "FieldDescription"

const FieldSeparator = () => <div className="h-px bg-border my-4" />

const FieldSet = React.forwardRef<HTMLFieldSetElement, React.HTMLAttributes<HTMLFieldSetElement>>(
  ({ className, ...props }, ref) => (
    <fieldset ref={ref} className={cn("space-y-4", className)} {...props} />
  )
)
FieldSet.displayName = "FieldSet"

const FieldLegend = React.forwardRef<HTMLLegendElement, React.HTMLAttributes<HTMLLegendElement>>(
  ({ className, ...props }, ref) => (
    <legend ref={ref} className={cn("text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 mb-2", className)} {...props} />
  )
)
FieldLegend.displayName = "FieldLegend"

const FieldContent = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
const FieldTitle = ({ children }: { children: React.ReactNode }) => <h4 className="font-medium">{children}</h4>

export { Field, FieldGroup, FieldLabel, FieldDescription, FieldSeparator, FieldSet, FieldLegend, FieldContent, FieldTitle }
