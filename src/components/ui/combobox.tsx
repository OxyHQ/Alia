"use client"

import * as React from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// Adapter for the demo code structure which expects Composition Pattern
// But we will simplify it to a single component for now if possible, or build the composite.

/* 
  The demo uses:
  <Combobox items={frameworks}>
     <ComboboxInput ... />
     <ComboboxContent>
        <ComboboxList>
             <ComboboxItem .../>
        </ComboboxList>
     </ComboboxContent>
  </Combobox>
*/

const ComboboxContext = React.createContext<{
  open: boolean,
  setOpen: (o: boolean) => void,
  value: string,
  setValue: (v: string) => void
} | null>(null)

export function Combobox({ items, children }: { items: readonly string[], children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState("")

  return (
    <ComboboxContext.Provider value={{ open, setOpen, value, setValue }}>
      <Popover open={open} onOpenChange={setOpen}>
        <div className="relative w-full">{children}</div>
      </Popover>
    </ComboboxContext.Provider>
  )
}

export function ComboboxInput({ placeholder, id, className, required }: { placeholder?: string, id?: string, className?: string, required?: boolean }) {
  const ctx = React.useContext(ComboboxContext)!

  // This is tricky because PopoverTrigger usually wraps a button. 
  // In the demo this looks like an Input that triggers the dropdown.

  return (
    <PopoverTrigger asChild>
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={ctx.open}
        className={cn("w-full justify-between font-normal", !ctx.value && "text-muted-foreground", className)}
        id={id}
      >
        {ctx.value
          ? ctx.value
          : placeholder || "Select..."}
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
  )
}

export function ComboboxContent({ children }: { children: React.ReactNode }) {
  return (
    <PopoverContent className="w-full p-0">
      <Command>
        {/* Check if children has ComboboxList/Item flow or standard Command flow */}
        {children}
      </Command>
    </PopoverContent>
  )
}

// Demo uses <ComboboxInput> then <ComboboxContent><ComboboxEmpty/><ComboboxList>...</ComboboxList></ComboboxContent>
// So we map these to Command components

export function ComboboxEmpty({ children }: { children: React.ReactNode }) {
  return <CommandEmpty>{children}</CommandEmpty>
}

export function ComboboxList({ children }: { children: React.ReactNode }) {
  // We need CommandInput here because Shadcn command usually puts input inside content
  // But the demo put input OUTSIDE. 
  // For simplicity, we add searching capability inside the list if needed, 
  // or assume the outer input was just a trigger.

  // To make it functional like standard shadcn combobox:
  return (
    <>
      <CommandInput placeholder="Search..." />
      <CommandList>
        <CommandGroup>
          {children}
        </CommandGroup>
      </CommandList>
    </>
  )
}

export function ComboboxItem({ value, children }: { value: string, children: React.ReactNode }) {
  const ctx = React.useContext(ComboboxContext)!

  return (
    <CommandItem
      value={value}
      onSelect={(currentValue: string) => {
        ctx.setValue(currentValue === ctx.value ? "" : currentValue)
        ctx.setOpen(false)
      }}
    >
      <Check
        className={cn(
          "mr-2 h-4 w-4",
          ctx.value === value ? "opacity-100" : "opacity-0"
        )}
      />
      {children}
    </CommandItem>
  )
}
