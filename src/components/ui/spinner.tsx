import { cn } from "@/lib/utils"
import { Loading03Icon as Loading03IconData } from "@hugeicons/core-free-icons"
import { createIcon } from "@/components/ui/hugeicon"

const Loading03Icon = createIcon(Loading03IconData)

export function Spinner({ className, ...props }: React.ComponentProps<typeof Loading03Icon>) {
    return (
        <Loading03Icon className={cn("h-4 w-4 animate-spin", className)} {...props} />
    )
}
