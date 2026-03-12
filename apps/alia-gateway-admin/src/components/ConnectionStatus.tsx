/**
 * Connection Status Indicator
 * Shows real-time WebSocket connection status
 */

import { useConnectionStatus, useRealtimeReconnect } from '@/lib/websocket/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function ConnectionStatus() {
  const status = useConnectionStatus();
  const reconnect = useRealtimeReconnect();

  const getStatusConfig = () => {
    switch (status) {
      case 'connected':
        return {
          label: 'Live',
          variant: 'default' as const,
          icon: Wifi,
          className: 'bg-green-500 hover:bg-green-600 text-white',
          tooltip: 'Connected - receiving real-time updates',
        };
      case 'connecting':
        return {
          label: 'Connecting',
          variant: 'secondary' as const,
          icon: RefreshCw,
          className: 'bg-blue-500 hover:bg-blue-600 text-white',
          tooltip: 'Connecting to server...',
        };
      case 'reconnecting':
        return {
          label: 'Reconnecting',
          variant: 'secondary' as const,
          icon: RefreshCw,
          className: 'bg-yellow-500 hover:bg-yellow-600 text-white animate-pulse',
          tooltip: 'Connection lost, attempting to reconnect...',
        };
      case 'disconnected':
        return {
          label: 'Offline',
          variant: 'destructive' as const,
          icon: WifiOff,
          className: 'bg-red-500 hover:bg-red-600 text-white',
          tooltip: 'Disconnected - click to reconnect',
        };
    }
  };

  const config = getStatusConfig();
  const Icon = config.icon;
  const isDisconnected = status === 'disconnected';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {isDisconnected ? (
            <Button
              size="sm"
              variant={config.variant}
              className={config.className}
              onClick={reconnect}
            >
              <Icon className="h-3 w-3 mr-1.5" />
              {config.label}
            </Button>
          ) : (
            <Badge variant={config.variant} className={config.className}>
              <Icon
                className={`h-3 w-3 mr-1.5 ${status === 'reconnecting' || status === 'connecting' ? 'animate-spin' : ''}`}
              />
              {config.label}
            </Badge>
          )}
        </TooltipTrigger>
        <TooltipContent>
          <p>{config.tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
