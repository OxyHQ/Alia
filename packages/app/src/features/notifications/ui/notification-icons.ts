import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiAlarmWarningLine } from '@oxy.so/bloom/icons/RiAlarmWarningLine';
import { RiEyeLine } from '@oxy.so/bloom/icons/RiEyeLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiMessage2Line } from '@oxy.so/bloom/icons/RiMessage2Line';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';

/** The glyph of each notification type; an unknown type draws the generic bell. */
const TYPE_ICONS: Record<string, BloomIconComponent> = {
  trigger_result: RiFlashlightLine,
  proactive_insight: RiEyeLine,
  daily_briefing: RiTimeLine,
  price_alert: RiAlarmWarningLine,
  reminder: RiNotification3Line,
  chat_response_ready: RiMessage2Line,
  agent_task_complete: RiFlashlightLine,
};

export function notificationIcon(type: string): BloomIconComponent {
  return TYPE_ICONS[type] ?? RiNotification3Line;
}
