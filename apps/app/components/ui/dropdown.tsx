import React, { useState, useRef, useEffect } from 'react';
import { View, Pressable, Modal, ScrollView, Dimensions } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { cn } from '@/lib/utils';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const insets = useSafeAreaInsets();
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpen = () => {
    // Clear any pending close
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }

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

  const handleMenuHoverIn = () => {
    // Clear any pending close when hovering over menu
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const handleMenuHoverOut = () => {
    // Close quickly when leaving menu
    closeTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 75) as any;
  };

  // Cleanup timeout
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  // Re-measure position when screen dimensions change
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', () => {
      if (isOpen) {
        triggerRef.current?.measureInWindow((x, y, width, height) => {
          if (x !== 0 || y !== 0 || width !== 0 || height !== 0) {
            setTriggerLayout({ x, y, width, height });
          }
        });
      }
    });

    return () => subscription?.remove();
  }, [isOpen]);

  const { width: windowWidth, height: windowHeight } = Dimensions.get('window');

  // Calculate if dropdown should appear above or below
  const dropdownMaxHeight = 300;
  const dropdownMinWidth = 200;
  const margin = 8;

  const safeBottom = windowHeight - insets.bottom;
  const safeTop = insets.top;

  const spaceBelow = safeBottom - (triggerLayout.y + triggerLayout.height);
  const spaceAbove = triggerLayout.y - safeTop;
  const shouldShowAbove = spaceBelow < dropdownMaxHeight && spaceAbove > spaceBelow;

  // Calculate horizontal position with margin and safe area constraints
  const safeLeft = insets.left + margin;
  const safeRight = windowWidth - insets.right - margin;

  let leftPosition = align === 'start' ? triggerLayout.x : undefined;
  let rightPosition = align === 'end' ? windowWidth - (triggerLayout.x + triggerLayout.width) : undefined;

  // Ensure dropdown doesn't go off screen horizontally
  if (align === 'start' && triggerLayout.x + dropdownMinWidth > safeRight) {
    leftPosition = undefined;
    rightPosition = insets.right + margin;
  } else if (align === 'start' && triggerLayout.x < safeLeft) {
    leftPosition = safeLeft;
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
        animationType="none"
        onRequestClose={handleClose}
      >
        <Pressable
          style={{ flex: 1 }}
          onPress={handleClose}
          pointerEvents="box-none"
        >
          <Pressable
            style={{
              position: 'absolute',
              top: shouldShowAbove ? undefined : triggerLayout.y + triggerLayout.height + 4,
              bottom: shouldShowAbove ? windowHeight - triggerLayout.y + 4 : undefined,
              left: leftPosition,
              right: rightPosition,
              minWidth: dropdownMinWidth,
              maxWidth: safeRight - safeLeft,
            }}
            className="bg-popover border-border rounded-2xl border"
            // @ts-ignore - onMouseEnter/Leave work on web
            onMouseEnter={handleMenuHoverIn}
            onMouseLeave={handleMenuHoverOut}
          >
            <ScrollView style={{ maxHeight: dropdownMaxHeight }} className="py-1 select-none">
              {React.Children.map(children, (child) =>
                React.isValidElement(child)
                  ? React.cloneElement(child as React.ReactElement<any>, { onClose: handleClose })
                  : child
              )}
            </ScrollView>
          </Pressable>
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
  const insets = useSafeAreaInsets();
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpen = () => {
    // Clear any pending close
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }

    triggerRef.current?.measureInWindow((x, y, width, height) => {
      if (x !== 0 || y !== 0 || width !== 0 || height !== 0) {
        setTriggerLayout({ x, y, width, height });
        setTimeout(() => setIsOpen(true), 0);
      }
    });
  };

  const handleHoverIn = () => {
    // Clear any pending close
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }

    // Open with minimal delay on hover
    if (!isOpen) {
      openTimeoutRef.current = setTimeout(() => {
        handleOpen();
      }, 50) as any;
    }
  };

  const handleHoverOut = () => {
    // Clear pending open
    if (openTimeoutRef.current) {
      clearTimeout(openTimeoutRef.current);
      openTimeoutRef.current = null;
    }

    // Don't close from trigger - let submenu handle it
    // This prevents the buggy loop
  };

  const handleSubmenuHoverIn = () => {
    // Clear any pending close when hovering over submenu
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const handleSubmenuHoverOut = () => {
    // Close quickly when leaving submenu
    closeTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 100) as any;
  };

  const handleItemClose = () => {
    setIsOpen(false);
    onClose?.();
  };

  // Cleanup timeouts
  useEffect(() => {
    return () => {
      if (openTimeoutRef.current) clearTimeout(openTimeoutRef.current);
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  // Close submenu when parent closes
  useEffect(() => {
    if (!isOpen) return;

    // If parent is closing, close this submenu too
    return () => {
      if (onClose) {
        setIsOpen(false);
      }
    };
  }, [onClose]);

  // Re-measure position when screen dimensions change
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', () => {
      if (isOpen) {
        triggerRef.current?.measureInWindow((x, y, width, height) => {
          if (x !== 0 || y !== 0 || width !== 0 || height !== 0) {
            setTriggerLayout({ x, y, width, height });
          }
        });
      }
    });

    return () => subscription?.remove();
  }, [isOpen]);

  const { width: windowWidth, height: windowHeight } = Dimensions.get('window');

  // Calculate if submenu should appear on left or right
  const submenuMinWidth = 200;
  const margin = 8;
  const submenuMaxHeight = 300;
  const overlap = 8; // Larger overlap for easier mouse movement

  const safeBottom = windowHeight - insets.bottom - margin;
  const safeTop = insets.top + margin;
  const safeLeft = insets.left + margin;
  const safeRight = windowWidth - insets.right - margin;

  // Calculate which side has more space
  const rightEdgePosition = triggerLayout.x + triggerLayout.width - overlap;
  const spaceRight = safeRight - rightEdgePosition;
  const leftEdgePosition = triggerLayout.x + overlap;
  const spaceLeft = leftEdgePosition - safeLeft;
  const shouldShowLeft = spaceRight < submenuMinWidth && spaceLeft > spaceRight;

  // Calculate horizontal position and clamp to safe area
  let leftPosition: number | undefined;
  let rightPosition: number | undefined;

  if (shouldShowLeft) {
    // Show to the left
    rightPosition = windowWidth - triggerLayout.x + overlap;
    // Ensure it doesn't go past left safe boundary
    const wouldBeLeft = windowWidth - rightPosition - submenuMinWidth;
    if (wouldBeLeft < safeLeft) {
      rightPosition = windowWidth - safeLeft - submenuMinWidth;
    }
  } else {
    // Show to the right
    leftPosition = Math.max(safeLeft, Math.min(rightEdgePosition, safeRight - submenuMinWidth));
  }

  // Calculate vertical position - align with trigger top, but keep in safe area
  let topPosition: number | undefined = triggerLayout.y - overlap;
  let bottomPosition: number | undefined = undefined;

  // Ensure submenu stays within safe area vertically
  if (topPosition < safeTop) {
    topPosition = safeTop;
  } else if (topPosition + submenuMaxHeight > safeBottom) {
    // If it would go past bottom, position from bottom instead
    topPosition = undefined;
    bottomPosition = windowHeight - safeBottom;
  }

  return (
    <>
      <View
        ref={triggerRef}
        collapsable={false}
        // @ts-ignore - onMouseEnter/Leave work on web
        onMouseEnter={handleHoverIn}
        onMouseLeave={handleHoverOut}
      >
        <Pressable
          onPress={handleOpen}
          className={cn(
            "group flex-row items-center gap-1.5 rounded-2xl px-2.5 py-1.5 mx-1",
            "active:bg-accent hover:bg-accent",
            isOpen && "bg-accent"
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
        animationType="none"
        onRequestClose={handleItemClose}
      >
        <Pressable
          style={{ flex: 1 }}
          onPress={handleItemClose}
          pointerEvents="box-none"
        >
          <Pressable
            style={{
              position: 'absolute',
              top: topPosition,
              bottom: bottomPosition,
              left: leftPosition,
              right: rightPosition,
              minWidth: submenuMinWidth,
              maxWidth: safeRight - safeLeft,
            }}
            className="bg-popover border-border rounded-2xl border"
            // @ts-ignore - onMouseEnter/Leave work on web
            onMouseEnter={handleSubmenuHoverIn}
            onMouseLeave={handleSubmenuHoverOut}
          >
            <ScrollView style={{ maxHeight: submenuMaxHeight }} className="py-1 select-none">
              {React.Children.map(children, (child) =>
                React.isValidElement(child)
                  ? React.cloneElement(child as React.ReactElement<any>, { onClose: handleItemClose })
                  : child
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
