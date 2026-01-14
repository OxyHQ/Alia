import { Button } from "@/components/ui/button"
import { MoreHorizontal } from "lucide-react"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function PresetActions() {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="secondary">
                    <span className="sr-only">Actions</span>
                    <MoreHorizontal className="h-4 w-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem>Content filter preferences</DropdownMenuItem>
                <DropdownMenuItem className="text-red-600">
                    Delete preset
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
