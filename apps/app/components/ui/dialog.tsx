import * as React from 'react';
import {
  Modal,
  View,
  Pressable,
  type ModalProps,
} from 'react-native';
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
  closeButton?: boolean;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof View>,
  DialogContentProps
>(({ className, overlayClassName, closeButton = true, children, ...props }, ref) => {
  const { open, onOpenChange } = React.useContext(DialogContext);

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
          'flex-1 items-center justify-center bg-black/50 p-6',
          overlayClassName
        )}
        onPress={() => onOpenChange?.(false)}
      >
        <Pressable
          ref={ref}
          className={cn(
            'w-full max-w-lg rounded-2xl bg-background p-6 shadow-lg',
            className
          )}
          onPress={(e) => e.stopPropagation()}
          {...props}
        >
          {closeButton && (
            <Pressable
              className="absolute right-4 top-4 z-10 rounded-lg p-1 active:opacity-70"
              onPress={() => onOpenChange?.(false)}
            >
              <X size={24} className="text-muted-foreground" />
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
      className={cn('mb-4 gap-1.5', className)}
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
      className={cn('text-lg font-semibold text-foreground', className)}
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
      className={cn('mt-6 flex-row gap-2', className)}
      {...props}
    />
  );
});

DialogFooter.displayName = 'DialogFooter';

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
