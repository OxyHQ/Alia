import * as React from 'react';
import { Text, type TextProps } from 'react-native';
import { cn } from '@/lib/utils';

const Label = React.forwardRef<Text, TextProps>(
  ({ className, ...props }, ref) => (
    <Text
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none text-foreground native:text-base',
        className
      )}
      {...props}
    />
  )
);
Label.displayName = 'Label';

export { Label };
