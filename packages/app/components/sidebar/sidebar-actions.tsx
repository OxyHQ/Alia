import { Button } from "@oxy.so/bloom/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@oxy.so/bloom/dropdown-menu";
import { RiMoreFill } from "@oxy.so/bloom/icons/RiMoreFill";

export function SidebarActions({
  label,
  items,
}: {
  label: string;
  items: { label: string; onPress: () => void; danger?: boolean }[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          icon={RiMoreFill}
          size="sm"
          appearance="plain"
          tone="neutral"
          accessibilityLabel={`${label} actions`}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onPress={item.onPress}
            tone={item.danger ? "danger" : undefined}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
