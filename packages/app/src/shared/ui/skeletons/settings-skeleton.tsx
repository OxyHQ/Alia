import { SettingsCard } from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/** What sits at the end of a settings row once its data is here. */
export type SettingsControlShape = 'value' | 'switch' | 'none';

const LABEL_WIDTHS = [128, 160, 108, 144] as const;

function ControlShape({ shape }: { shape: SettingsControlShape }) {
  if (shape === 'none') return null;
  // The value field is 202 x 32 and the switch 52 x 28: Bloom's own measures.
  return shape === 'switch' ? (
    <Skeleton.Box width={52} height={28} borderRadius={14} />
  ) : (
    <Skeleton.Box width={202} height={32} borderRadius={10} />
  );
}

/**
 * The rows of a settings card that are on their way, for a card that holds other things too (a
 * list that is empty or full once it is here). Each row has Bloom's geometry (52 tall, 16 between
 * the label and its control, the hairline under all but the last), with the label and the control
 * drawn as placeholders: the row holds its place and nothing moves when the data arrives.
 */
export function SettingsSkeletonRows({
  rows = 1,
  control = 'value',
}: {
  rows?: number;
  control?: SettingsControlShape;
}) {
  return (
    <Skeleton.Region>
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          className={`min-h-[52px] flex-row items-center justify-between gap-4 py-2.5 pr-2.5 ${
            index === rows - 1 ? '' : 'border-b border-border'
          }`}
        >
          <Skeleton.Box width={LABEL_WIDTHS[index % LABEL_WIDTHS.length]} height={14} />
          <ControlShape shape={control} />
        </View>
      ))}
    </Skeleton.Region>
  );
}

/** A whole settings card of {@link SettingsSkeletonRows}. */
export function SettingsRowsSkeleton(props: { rows?: number; control?: SettingsControlShape }) {
  return (
    <SettingsCard>
      <SettingsSkeletonRows {...props} />
    </SettingsCard>
  );
}
