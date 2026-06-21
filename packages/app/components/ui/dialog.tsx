import * as React from 'react';
import {
  Modal,
  View,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { cn } from '@/lib/utils';
import { Text } from './text';

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

const Dialog = ({ open, onOpenChange, children }: DialogProps) => {
  return (
    <DialogContext.Provider value={{ open: open ?? false, onOpenChange }}>
      {children}
    </DialogContext.Provider>
  );
};

const DialogContext = React.createContext<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}>({
  open: false,
});

const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  React.ComponentPropsWithoutRef<typeof Pressable>
>(({ onPress, ...props }, ref) => {
  const { onOpenChange } = React.useContext(DialogContext);

  return (
    <Pressable
      ref={ref}
      onPress={(e) => {
        onOpenChange?.(true);
        onPress?.(e);
      }}
      {...props}
    />
  );
});

DialogTrigger.displayName = 'DialogTrigger';

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof View> {
  overlayClassName?: string;
  showCloseButton?: boolean;
  /** @deprecated Use showCloseButton instead */
  closeButton?: boolean;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof View>,
  DialogContentProps
>(({ className, overlayClassName, showCloseButton, closeButton, children, ...props }, ref) => {
  const { open, onOpenChange } = React.useContext(DialogContext);
  const shouldShowClose = showCloseButton ?? closeButton ?? true;
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={() => onOpenChange?.(false)}
      statusBarTranslucent
    >
      <Pressable
        className={cn(
          'flex-1 items-center justify-center bg-black/50 px-4 sm:px-0',
          overlayClassName
        )}
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        onPress={() => onOpenChange?.(false)}
      >
        <Pressable
          ref={ref}
          className={cn(
            'w-full max-w-lg gap-4 rounded-lg border border-border bg-background p-6 shadow-lg',
            className
          )}
          onPress={(e) => e.stopPropagation()}
          {...props}
        >
          {shouldShowClose && (
            <Pressable
              className="absolute right-4 top-4 z-10 rounded-sm opacity-70 active:opacity-100"
              onPress={() => onOpenChange?.(false)}
            >
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          )}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
});

DialogContent.displayName = 'DialogContent';

const DialogHeader = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentPropsWithoutRef<typeof View>
>(({ className, ...props }, ref) => {
  return (
    <View
      ref={ref}
      className={cn('flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  );
});

DialogHeader.displayName = 'DialogHeader';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentPropsWithoutRef<typeof Text>
>(({ className, ...props }, ref) => {
  return (
    <Text
      ref={ref}
      className={cn('text-lg leading-none font-semibold text-foreground', className)}
      {...props}
    />
  );
});

DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentPropsWithoutRef<typeof Text>
>(({ className, ...props }, ref) => {
  return (
    <Text
      ref={ref}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
});

DialogDescription.displayName = 'DialogDescription';

const DialogFooter = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentPropsWithoutRef<typeof View>
>(({ className, ...props }, ref) => {
  return (
    <View
      ref={ref}
      className={cn('flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
});

DialogFooter.displayName = 'DialogFooter';

const DialogClose = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  React.ComponentPropsWithoutRef<typeof Pressable>
>(({ onPress, ...props }, ref) => {
  const { onOpenChange } = React.useContext(DialogContext);

  return (
    <Pressable
      ref={ref}
      onPress={(e) => {
        onOpenChange?.(false);
        onPress?.(e);
      }}
      {...props}
    />
  );
});

DialogClose.displayName = 'DialogClose';

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
