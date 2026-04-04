import * as React from 'react';
import { Platform, TextInput } from 'react-native';
import { cn } from '@/lib/utils';

interface TextareaProps extends React.ComponentPropsWithoutRef<typeof TextInput> {
  variant?: 'default' | 'ghost';
}

const Textarea = React.forwardRef<TextInput, TextareaProps>(
  ({ className, placeholderClassName, style, variant = 'default', ...props }, ref) => {
    return (
      <TextInput
        ref={ref}
        className={cn(
          'text-base text-foreground web:flex web:w-full lg:text-sm',
          variant === 'default' && [
            'native:min-h-[80px] native:text-md native:leading-[1.25] min-h-[60px] rounded-xl border border-input bg-background px-3.5 py-2.5',
            'web:ring-offset-background web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2',
          ],
          variant === 'ghost' && 'p-0',
          props.editable === false && 'opacity-50 web:cursor-not-allowed',
          className,
        )}
        placeholderClassName={cn('text-muted-foreground', placeholderClassName)}
        multiline
        scrollEnabled={false}
        textAlignVertical="top"
        style={[
          Platform.OS === 'web' ? ({ fieldSizing: 'content' } as any) : undefined,
          style,
        ]}
        {...props}
      />
    );
  },
);

Textarea.displayName = 'Textarea';

export { Textarea };
export type { TextareaProps };
