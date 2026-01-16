import React, { useState, useRef } from 'react';
import { View, Pressable, Modal, ScrollView, Dimensions } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { cn } from '@/lib/utils';

type DropdownMenuProps = {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'end' | 'center';
};

type MenuItemProps = {
  onPress?: () => void;
  children: React.ReactNode;
  className?: string;
  onClose?: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
};

type SubMenuProps = {
  trigger: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
};

type SeparatorProps = {
  className?: string;
};

type ShortcutProps = {
  children: React.ReactNode;
  className?: string;
};

export function Dropdown({ trigger, children, align = 'start' }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [triggerLayout, setTriggerLayout] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const triggerRef = useRef<View>(null);

  const handleOpen = () => {
    // Measure first, then open after measurement completes
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      // Only open if we got valid measurements
      if (x !== 0 || y !== 0 || width !== 0 || height !== 0) {
        setTriggerLayout({ x, y, width, height });
        // Use setTimeout to ensure the state update completes
        setTimeout(() => setIsOpen(true), 0);
      }
    });
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  const { width: windowWidth, height: windowHeight } = Dimensions.get('window');

  // Calculate if dropdown should appear above or below
  const dropdownMaxHeight = 400;
  const dropdownMinWidth = 224;
  const margin = 16;

  const spaceBelow = windowHeight - (triggerLayout.y + triggerLayout.height);
  const spaceAbove = triggerLayout.y;
  const shouldShowAbove = spaceBelow < dropdownMaxHeight && spaceAbove > spaceBelow;

  // Calculate horizontal position with margin constraints
  let leftPosition = align === 'start' ? triggerLayout.x : undefined;
  let rightPosition = align === 'end' ? windowWidth - (triggerLayout.x + triggerLayout.width) : undefined;

  // Ensure dropdown doesn't go off screen horizontally
  if (align === 'start' && triggerLayout.x + dropdownMinWidth > windowWidth - margin) {
    leftPosition = undefined;
    rightPosition = margin;
  } else if (align === 'start' && triggerLayout.x < margin) {
    leftPosition = margin;
  }

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        {React.isValidElement(trigger)
          ? React.cloneElement(trigger as React.ReactElement<any>, { onPress: handleOpen })
          : trigger}
      </View>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
      >
        <Pressable
          style={{ flex: 1 }}
          onPress={handleClose}
        >
          <View
            style={{
              position: 'absolute',
              top: shouldShowAbove ? undefined : triggerLayout.y + triggerLayout.height + 4,
              bottom: shouldShowAbove ? windowHeight - triggerLayout.y + 4 : undefined,
              left: leftPosition,
              right: rightPosition,
              minWidth: dropdownMinWidth,
              maxWidth: windowWidth - (margin * 2),
            }}
            className="bg-popover border-border rounded-2xl border shadow-lg"
          >
            <ScrollView className="max-h-[400px] py-1 select-none">
              {React.Children.map(children, (child) =>
                React.isValidElement(child)
                  ? React.cloneElement(child as React.ReactElement<any>, { onClose: handleClose })
                  : child
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

export function MenuItem({ onPress, children, className, onClose, variant = 'default', disabled = false }: MenuItemProps) {
  const handlePress = () => {
    if (disabled) return;
    onPress?.();
    onClose?.();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className={cn(
        "group flex-row items-center gap-1.5 rounded-2xl px-2.5 py-1.5 mx-1",
        !disabled && "active:bg-accent hover:bg-accent",
        variant === 'destructive' && "text-destructive",
        disabled && "opacity-50",
        className
      )}
    >
      {children}
    </Pressable>
  );
}

export function Separator({ className }: SeparatorProps) {
  return (
    <View className={cn("h-px bg-border my-1 mx-2", className)} />
  );
}

export function Shortcut({ children, className }: ShortcutProps) {
  return (
    <View className={cn("ml-auto pl-2", className)}>
      {children}
    </View>
  );
}

export function SubMenu({ trigger, children, onClose }: SubMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [triggerLayout, setTriggerLayout] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const triggerRef = useRef<View>(null);

  const handleOpen = () => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      if (x !== 0 || y !== 0 || width !== 0 || height !== 0) {
        setTriggerLayout({ x, y, width, height });
        setTimeout(() => setIsOpen(true), 0);
      }
    });
  };

  const handleItemClose = () => {
    setIsOpen(false);
    onClose?.();
  };

  const { width: windowWidth, height: windowHeight } = Dimensions.get('window');

  // Calculate if submenu should appear on left or right
  const submenuMinWidth = 224;
  const margin = 16;
  const spaceRight = windowWidth - (triggerLayout.x + triggerLayout.width);
  const spaceLeft = triggerLayout.x;
  const shouldShowLeft = spaceRight < submenuMinWidth && spaceLeft > spaceRight;

  // Calculate vertical position
  const dropdownMaxHeight = 400;
  const spaceBelow = windowHeight - triggerLayout.y;
  const spaceAbove = triggerLayout.y;
  const shouldShowAbove = spaceBelow < dropdownMaxHeight && spaceAbove > spaceBelow;

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        <Pressable
          onPress={handleOpen}
          className={cn(
            "group flex-row items-center gap-1.5 rounded-2xl px-2.5 py-1.5 mx-1",
            "active:bg-accent hover:bg-accent"
          )}
        >
          <View className="flex-row items-center gap-1.5 flex-1">
            {trigger}
          </View>
          <ChevronRight
            size={16}
            className="text-muted-foreground -me-0.25"
          />
        </Pressable>
      </View>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={handleItemClose}
      >
        <Pressable
          style={{ flex: 1 }}
          onPress={handleItemClose}
        >
          <View
            style={{
              position: 'absolute',
              top: shouldShowAbove ? undefined : triggerLayout.y,
              bottom: shouldShowAbove ? windowHeight - (triggerLayout.y + triggerLayout.height) : undefined,
              left: shouldShowLeft ? undefined : triggerLayout.x + triggerLayout.width + 4,
              right: shouldShowLeft ? windowWidth - triggerLayout.x + 4 : undefined,
              minWidth: submenuMinWidth,
              maxWidth: windowWidth - (margin * 2),
            }}
            className="bg-popover border-border rounded-2xl border shadow-lg"
          >
            <ScrollView className="max-h-[400px] py-1 select-none">
              {React.Children.map(children, (child) =>
                React.isValidElement(child)
                  ? React.cloneElement(child as React.ReactElement<any>, { onClose: handleItemClose })
                  : child
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
