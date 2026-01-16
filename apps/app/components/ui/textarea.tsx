import * as React from 'react';
import { TextInput } from 'react-native';
import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<
  TextInput,
  React.ComponentPropsWithoutRef<typeof TextInput>
>(({ className, placeholderClassName, ...props }, ref) => {
  return (
    <TextInput
      ref={ref}
      className={cn(
        'native:min-h-[80px] native:text-md native:leading-[1.25] min-h-[60px] rounded-xl border border-input bg-background px-3.5 py-2.5 text-base text-foreground web:flex web:w-full lg:text-sm',
        'web:ring-offset-background web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2',
        props.editable === false && 'opacity-50 web:cursor-not-allowed',
        className
      )}
      placeholderClassName={cn('text-muted-foreground', placeholderClassName)}
      multiline
      textAlignVertical="top"
      {...props}
    />
  );
});

Textarea.displayName = 'Textarea';

export { Textarea };
