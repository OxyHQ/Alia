"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
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

import { Preset } from "../data/presets"

interface PresetSelectorProps extends React.ComponentPropsWithoutRef<typeof PopoverTrigger> {
    presets: Preset[]
}

export function PresetSelector({ presets, className, ...props }: PresetSelectorProps) {
    const [open, setOpen] = React.useState(false)
    const [selectedPreset, setSelectedPreset] = React.useState<Preset>()
    const router = useRouter()

    return (
        <Popover open={open} onOpenChange={setOpen} {...props}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    aria-label="Load a preset..."
                    className={cn("w-[200px] justify-between", className)}
                >
                    {selectedPreset ? selectedPreset.name : "Load a preset..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[200px] p-0">
                <Command>
                    <CommandInput placeholder="Search presets..." />
                    <CommandList>
                        <CommandEmpty>No results found.</CommandEmpty>
                        <CommandGroup heading="Examples">
                            {presets.map((preset) => (
                                <CommandItem
                                    key={preset.id}
                                    onSelect={() => {
                                        setSelectedPreset(preset)
                                        setOpen(false)
                                    }}
                                >
                                    {preset.name}
                                    <Check
                                        className={cn(
                                            "ml-auto h-4 w-4",
                                            selectedPreset?.id === preset.id
                                                ? "opacity-100"
                                                : "opacity-0"
                                        )}
                                    />
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandGroup className="pt-0">
                            <CommandItem onSelect={() => router.push("/examples")}>
                                More examples
                            </CommandItem>
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    )
}
