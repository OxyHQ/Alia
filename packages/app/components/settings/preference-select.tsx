import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';

/**
 * The settings modal story's `CompactSelect`: Bloom's md select with the
 * compact row trigger (`h-8 gap-1 px-2 py-1.5`, spelled here as the trigger's
 * `fieldStyle` longhands so no utility class is needed), typed on its values.
 */
const COMPACT_TRIGGER = {
  height: 32,
  gap: 4,
  paddingLeft: 8,
  paddingRight: 8,
  paddingTop: 6,
  paddingBottom: 6,
} as const;

export function SettingsPreferenceSelect<T extends string>({
  label,
  value,
  onChange,
  items,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: readonly { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const item = items.find((item) => item.value === next);
        if (item) onChange(item.value);
      }}
    >
      <SelectTrigger label={label} fieldStyle={COMPACT_TRIGGER}>
        <SelectValue>
          {(v) => {
            const key =
              typeof v === 'object' && v !== null && 'value' in v
                ? (v as { value: string }).value
                : v;
            return (
              items.find((item) => item.value === key)?.label ??
              items.find((item) => item.value === value)?.label ??
              String(key ?? value)
            );
          }}
        </SelectValue>
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        label={label}
        items={[...items]}
        valueExtractor={(item) => item.value}
        renderItem={(item) => (
          <SelectItem value={item.value} label={item.label}>
            <SelectItemIndicator />
            <SelectItemText>{item.label}</SelectItemText>
          </SelectItem>
        )}
      />
    </Select>
  );
}
