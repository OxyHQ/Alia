import * as React from "react";
import { createPortal } from "react-dom";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react-native";
import { cn } from "@/lib/utils";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-xl p-1",
        className
      )}
      {...props}
    />
  );
}

interface CommandDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

function CommandDialog({ open, onOpenChange, children }: CommandDialogProps) {
  const [mounted, setMounted] = React.useState(false);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      // Trigger enter animation on next frame
      requestAnimationFrame(() => setVisible(true));
    } else if (mounted) {
      // Trigger exit animation, then unmount
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 150);
      return () => clearTimeout(timer);
    }
  }, [open]);

  React.useEffect(() => {
    if (!mounted) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange?.(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mounted, onOpenChange]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 isolate">
      <div
        className={cn(
          "fixed inset-0 bg-black/10 backdrop-blur-[2px] transition-opacity duration-150",
          visible ? "opacity-100" : "opacity-0"
        )}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenChange?.(false);
        }}
      />
      <div
        className={cn(
          "fixed left-1/2 top-1/3 z-50 w-full max-w-lg -translate-x-1/2 rounded-xl bg-background p-0 text-sm ring-1 ring-foreground/10 shadow-lg overflow-hidden transition-all duration-150",
          visible
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 -translate-y-2"
        )}
      >
        <Command>
          {children}
        </Command>
      </div>
    </div>,
    document.body
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="p-1 pb-0">
      <div className="flex items-center gap-2 rounded-lg bg-input/30 border border-input/30 px-2 h-8">
        <Search size={16} className="shrink-0 opacity-50" />
        <CommandPrimitive.Input
          autoFocus
          className={cn(
            "placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
          {...props}
        />
      </div>
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn(
        "max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]",
        className
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "text-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium",
        className
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      className={cn("bg-border -mx-1 h-px", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "group/command-item data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground [&[data-selected=true]_svg:not([class*='text-'])]:text-foreground relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
