import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';

export interface EditorSelectItem {
  value: string;
  label: string;
}

/** A Bloom `Select` for one row of the agent editor: the trigger fills the row's control cell. */
export function EditorSelect({
  label,
  value,
  items,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  items: readonly EditorSelectItem[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select size="sm" value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger label={label}>
        <SelectValue placeholder={label} />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        label={label}
        items={items.map((item) => ({ ...item, id: item.value }))}
        width={224}
        valueExtractor={(item) => item.id}
        renderItem={(item) => (
          <SelectItem value={item.id} label={item.label}>
            <SelectItemText>{item.label}</SelectItemText>
          </SelectItem>
        )}
      />
    </Select>
  );
}
