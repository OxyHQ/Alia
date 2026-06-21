import * as React from 'react';
import { Pressable, View } from 'react-native';
import { cn } from '@/lib/utils';
import { Text } from './text';

interface ToggleGroupProps {
  type: 'single' | 'multiple';
  value?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  children: React.ReactNode;
  className?: string;
}

const ToggleGroupContext = React.createContext<{
  type: 'single' | 'multiple';
  value: string | string[];
  onValueChange: (value: string) => void;
}>({
  type: 'single',
  value: '',
  onValueChange: () => {},
});

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof View>,
  ToggleGroupProps
>(({ type, value = type === 'single' ? '' : [], onValueChange, className, children }, ref) => {
  const handleValueChange = React.useCallback(
    (itemValue: string) => {
      if (type === 'single') {
        onValueChange?.(itemValue === value ? '' : itemValue);
      } else {
        const currentValue = value as string[];
        const newValue = currentValue.includes(itemValue)
          ? currentValue.filter((v) => v !== itemValue)
          : [...currentValue, itemValue];
        onValueChange?.(newValue);
      }
    },
    [type, value, onValueChange]
  );

  return (
    <ToggleGroupContext.Provider
      value={{
        type,
        value: value ?? (type === 'single' ? '' : []),
        onValueChange: handleValueChange,
      }}
    >
      <View ref={ref} className={cn('flex-row flex-wrap gap-2', className)}>
        {children}
      </View>
    </ToggleGroupContext.Provider>
  );
});

ToggleGroup.displayName = 'ToggleGroup';

interface ToggleGroupItemProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  activeClassName?: string;
  textClassName?: string;
  activeTextClassName?: string;
}

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  ToggleGroupItemProps
>(
  (
    {
      value: itemValue,
      children,
      className,
      activeClassName,
      textClassName,
      activeTextClassName,
    },
    ref
  ) => {
    const { type, value, onValueChange } = React.useContext(ToggleGroupContext);

    const isActive = React.useMemo(() => {
      if (type === 'single') {
        return value === itemValue;
      }
      return (value as string[]).includes(itemValue);
    }, [type, value, itemValue]);

    return (
      <Pressable
        ref={ref}
        onPress={() => onValueChange(itemValue)}
        className={cn(
          'rounded-full border border-border bg-background px-4 py-2 active:opacity-70',
          isActive && 'border-primary bg-primary',
          className,
          isActive && activeClassName
        )}
      >
        {typeof children === 'string' ? (
          <Text
            className={cn(
              'text-sm font-medium text-foreground',
              isActive && 'text-primary-foreground',
              textClassName,
              isActive && activeTextClassName
            )}
          >
            {children}
          </Text>
        ) : (
          children
        )}
      </Pressable>
    );
  }
);

ToggleGroupItem.displayName = 'ToggleGroupItem';

export { ToggleGroup, ToggleGroupItem };
