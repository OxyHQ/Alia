// Web dropdown menu using Radix UI with the app's Tailwind styling.
// Provides the same zeego-compatible API as the native dropdown-menu.tsx.
import { cn } from "@/lib/utils";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import * as React from "react";
import {
  Star, Pencil, Trash2, Share2, Download, Settings, HelpCircle,
  Image, FileText, Search, ShoppingBag, MoreHorizontal, ExternalLink,
  BookOpen, Globe, PenTool, Sparkles, User, CreditCard, Bell, LogOut,
  Folder, Check, Brain, Ghost, Bot,
} from "lucide-react-native";

// Map iOS SF Symbol names to Lucide icons for web rendering
const SF_SYMBOL_MAP: Record<string, React.ComponentType<any>> = {
  "star": Star, "star.fill": Star, "pencil": Pencil, "trash": Trash2,
  "square.and.arrow.up": Share2, "arrow.down.doc": Download,
  "gearshape": Settings, "questionmark.circle": HelpCircle,
  "photo": Image, "doc": FileText, "magnifyingglass": Search,
  "bag": ShoppingBag, "ellipsis": MoreHorizontal, "link": ExternalLink,
  "book": BookOpen, "globe": Globe, "pencil.tip": PenTool,
  "sparkle": Sparkles, "person.circle": User, "creditcard": CreditCard,
  "bell": Bell, "rectangle.portrait.and.arrow.right": LogOut,
  "folder": Folder, "checkmark": Check, "brain": Brain,
  "eye.slash": Ghost, "cpu": Bot,
};


const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuGroup = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Group> & {
    horizontal?: boolean;
  }
>(({ className, horizontal, children, ...props }, ref) => (
  <DropdownMenuPrimitive.Group
    ref={ref}
    className={cn(
      horizontal && "flex flex-row space-x-2 justify-between",
      className
    )}
    {...props}
  >
    {children}
  </DropdownMenuPrimitive.Group>
));
DropdownMenuGroup.displayName = DropdownMenuPrimitive.Group.displayName;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground [&:focus_svg:not([class*='text-'])]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      inset && "pl-8",
      className
    )}
    {...props}
  >
    {children}
    <ChevronRightIcon className="ml-auto h-4 w-4" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName =
  DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, style, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      className={cn(
        "z-[9999] min-w-[96px] rounded-md bg-popover p-1 text-popover-foreground duration-100 origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      style={{
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
        border: '1px solid hsl(var(--border))',
        ...style as any,
      }}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName =
  DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, align = "start", style, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={cn(
        "z-[9999] min-w-[8rem] rounded-lg bg-popover p-1 text-popover-foreground duration-100 max-h-[var(--radix-dropdown-menu-content-available-height)] origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-x-hidden overflow-y-auto data-[state=closed]:overflow-hidden",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      style={{
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
        border: '1px solid hsl(var(--border))',
        ...style as any,
      }}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    destructive?: boolean;
    shouldDismissMenuOnSelect?: boolean;
  }
>(
  (
    {
      className,
      inset,
      destructive,
      shouldDismissMenuOnSelect,
      onSelect,
      ...props
    },
    ref
  ) => (
    <DropdownMenuPrimitive.Item
      ref={ref}
      onSelect={(e) => {
        onSelect?.(e);
        if (shouldDismissMenuOnSelect === false) {
          e.preventDefault();
        }
      }}
      className={cn(
        "relative flex flex-row cursor-default select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg:not([class*='text-'])]:text-muted-foreground [&:focus_svg:not([class*='text-'])]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        inset && "pl-8",
        destructive &&
          "text-destructive focus:text-destructive focus:bg-destructive/10 dark:focus:bg-destructive/20 [&_svg]:!text-destructive",
        className
      )}
      {...props}
    />
  )
);
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  Omit<
    React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>,
    "onSelect" | "checked"
  > & {
    value: "mixed" | "on" | "off" | boolean;
    onValueChange?: (
      state: "mixed" | "on" | "off",
      prevState: "mixed" | "on" | "off"
    ) => void;
    shouldDismissMenuOnSelect?: boolean;
  }
>(
  (
    {
      className,
      value,
      children,
      shouldDismissMenuOnSelect,
      onValueChange,
      ...props
    },
    ref
  ) => (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      onSelect={(e) => {
        const current =
          value === true ? "on" : value === false ? "off" : value;
        const next = current === "on" ? "off" : "on";
        onValueChange?.(next, current);
        if (shouldDismissMenuOnSelect === false) {
          e.preventDefault();
        }
      }}
      className={cn(
        "relative flex cursor-default select-none items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground [&:focus_svg:not([class*='text-'])]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={typeof value === "boolean" ? value : value !== "off"}
      {...props}
    >
      <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
);
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "text-muted-foreground px-1.5 py-1 text-xs font-medium",
      inset && "pl-8",
      className
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName =
  DropdownMenuPrimitive.Separator.displayName;

export const ItemIcon = React.forwardRef<
  HTMLSpanElement,
  React.HTMLProps<HTMLSpanElement> & { ios?: { name?: string; [key: string]: any }; androidIconName?: string }
>(({ className, ios, androidIconName, children, ...props }, ref) => {
  const IconComponent = ios?.name ? SF_SYMBOL_MAP[ios.name] : null;
  return (
    <span ref={ref} className={cn("inline-flex h-4 w-4 items-center justify-center shrink-0 text-muted-foreground", className)} {...props}>
      {IconComponent ? <IconComponent size={16} /> : children}
    </span>
  );
});
ItemIcon.displayName = "ItemIcon";

export const ItemTitle = React.forwardRef<
  HTMLSpanElement,
  React.HTMLProps<HTMLSpanElement>
>((props, ref) => {
  return <span ref={ref} {...props} />;
});
ItemTitle.displayName = "ItemTitle";

export const ItemSubtitle = React.forwardRef<
  HTMLSpanElement,
  React.HTMLProps<HTMLSpanElement>
>(({ className, ...props }, ref) => {
  return (
    <span
      ref={ref}
      className={cn("block text-xs text-muted-foreground mt-0.5", className)}
      {...props}
    />
  );
});
ItemSubtitle.displayName = "ItemSubtitle";

export { ItemImage, ItemIndicator, Arrow } from "zeego/dropdown-menu";

export {
  DropdownMenu as Root,
  DropdownMenuTrigger as Trigger,
  DropdownMenuContent as Content,
  DropdownMenuItem as Item,
  DropdownMenuCheckboxItem as CheckboxItem,
  DropdownMenuLabel as Label,
  DropdownMenuSeparator as Separator,
  DropdownMenuGroup as Group,
  DropdownMenuSub as Sub,
  DropdownMenuSubContent as SubContent,
  DropdownMenuSubTrigger as SubTrigger,
};
