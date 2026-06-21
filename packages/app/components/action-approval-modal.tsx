/**
 * ActionApprovalModal — Real-time approval dialog for flagged agent actions.
 *
 * When the threat detector flags an agent action, this modal appears
 * asking the user to approve, deny, or always-allow the action.
 * Includes a countdown timer that auto-denies on expiration.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ShieldAlert, ShieldCheck, ShieldX, Clock, Terminal, Globe, FileEdit, Users } from 'lucide-react-native';
import Animated, { FadeIn, useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useColorScheme } from '@/lib/useColorScheme';

export interface ApprovalRequest {
  requestId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  severity: 'warning' | 'critical';
  timeout: number;
}

interface ActionApprovalModalProps {
  request: ApprovalRequest | null;
  onRespond: (requestId: string, approved: boolean, alwaysAllow?: boolean) => void;
}

const TOOL_ICONS: Record<string, React.ComponentType<any>> = {
  shell: Terminal,
  browser: Globe,
  file_edit: FileEdit,
  delegate: Users,
};

const SEVERITY_COLORS = {
  warning: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-600', icon: 'text-yellow-500' },
  critical: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-600', icon: 'text-red-500' },
};

export function ActionApprovalModal({ request, onRespond }: ActionApprovalModalProps) {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { isDarkColorScheme } = useColorScheme();

  // Progress bar animation
  const progress = useSharedValue(1);
  const progressStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  useEffect(() => {
    if (!request) return;

    const totalSeconds = Math.ceil(request.timeout / 1000);
    setSecondsLeft(totalSeconds);
    setAlwaysAllow(false);
    progress.value = 1;
    progress.value = withTiming(0, { duration: request.timeout });

    timerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          onRespond(request.requestId, false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [request]);

  const handleApprove = useCallback(() => {
    if (!request) return;
    if (timerRef.current) clearInterval(timerRef.current);
    onRespond(request.requestId, true, alwaysAllow);
  }, [request, alwaysAllow, onRespond]);

  const handleDeny = useCallback(() => {
    if (!request) return;
    if (timerRef.current) clearInterval(timerRef.current);
    onRespond(request.requestId, false);
  }, [request, onRespond]);

  if (!request) return null;

  const colors = SEVERITY_COLORS[request.severity] || SEVERITY_COLORS.warning;
  const ToolIcon = TOOL_ICONS[request.toolName] || Terminal;
  const ShieldIcon = request.severity === 'critical' ? ShieldX : ShieldAlert;

  const argsDisplay = Object.entries(request.args)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');

  return (
    <Dialog open={!!request}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <Animated.View entering={FadeIn} className="flex-row items-center gap-2">
            <ShieldIcon size={20} className={colors.icon} />
            <DialogTitle className={colors.text}>
              {request.severity === 'critical' ? 'Security Alert' : 'Action Review'}
            </DialogTitle>
          </Animated.View>
          <DialogDescription>
            {request.description}
          </DialogDescription>
        </DialogHeader>

        <View className="gap-3">
          {/* Tool info */}
          <View className={`${colors.bg} ${colors.border} border rounded-lg p-3`}>
            <View className="flex-row items-center gap-2 mb-2">
              <ToolIcon size={16} className={colors.text} />
              <Text className={`${colors.text} font-semibold text-sm`}>
                {request.toolName}
              </Text>
            </View>
            <ScrollView style={{ maxHeight: 120 }}>
              <Text className="text-xs font-mono text-muted-foreground">
                {argsDisplay}
              </Text>
            </ScrollView>
          </View>

          {/* Timer */}
          <View className="gap-1">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-1">
                <Clock size={12} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">
                  Auto-deny in {secondsLeft}s
                </Text>
              </View>
            </View>
            <View className="h-1 bg-muted rounded-full overflow-hidden">
              <Animated.View
                style={[progressStyle]}
                className={`h-full ${request.severity === 'critical' ? 'bg-red-500' : 'bg-yellow-500'} rounded-full`}
              />
            </View>
          </View>

          {/* Always allow checkbox */}
          <Pressable
            className="flex-row items-center gap-2"
            onPress={() => setAlwaysAllow(!alwaysAllow)}
          >
            <View className={`w-4 h-4 border rounded ${alwaysAllow ? 'bg-primary border-primary' : 'border-muted-foreground'} items-center justify-center`}>
              {alwaysAllow && <ShieldCheck size={10} className="text-primary-foreground" />}
            </View>
            <Text className="text-xs text-muted-foreground">
              Always allow this action for this session
            </Text>
          </Pressable>
        </View>

        <DialogFooter className="flex-row gap-2">
          <Button variant="outline" onPress={handleDeny} className="flex-1">
            <Text>Deny</Text>
          </Button>
          <Button
            onPress={handleApprove}
            className={`flex-1 ${request.severity === 'critical' ? 'bg-red-600' : 'bg-yellow-600'}`}
          >
            <Text className="text-white">Approve</Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
