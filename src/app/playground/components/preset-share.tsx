import { Button } from "@/components/ui/button"
import { Share2 } from "lucide-react"

export function PresetShare() {
    return (
        <Button variant="outline">
            <Share2 className="mr-2 h-4 w-4" />
            Share
        </Button>
    )
}
