import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmVariant = "default",
  onConfirm,
  loading = false,
}: ConfirmationDialogProps) {
  const handleConfirm = async () => {
    await onConfirm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeButton={true} className="max-w-sm">
        <DialogHeader className="gap-1">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription className="text-sm">{description}</DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 mt-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-9"
            onPress={() => onOpenChange(false)}
            disabled={loading}
          >
            <Text className="text-sm">{cancelText}</Text>
          </Button>
          <Button
            variant={confirmVariant}
            size="sm"
            className="flex-1 h-9"
            onPress={handleConfirm}
            disabled={loading}
          >
            <Text className="text-sm">{loading ? "Processing..." : confirmText}</Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
