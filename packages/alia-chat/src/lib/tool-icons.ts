import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiDatabase2Line } from '@oxy.so/bloom/icons/RiDatabase2Line';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLightbulbFlashLine } from '@oxy.so/bloom/icons/RiLightbulbFlashLine';
import { RiLink } from '@oxy.so/bloom/icons/RiLink';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';

/** The glyph a tool's step carries in the thought panel, by tool name. */
const TOOL_ICONS: ReadonlyMap<string, BloomIconComponent> = new Map([
  ['webSearch', RiSearchLine],
  ['scrapeURL', RiLink],
  ['getTimeline', RiCalendarLine],
  ['searchKnowledgeBase', RiDatabase2Line],
  ['webScraper', RiGlobalLine],
  ['browse', RiGlobalLine],
  ['sendWhatsAppMessage', RiChat3Line],
  ['getWhatsAppChats', RiChat3Line],
  ['getWhatsAppMessages', RiChat3Line],
  ['sendTelegramMessage', RiSendPlaneLine],
  ['getCurrentDate', RiCalendarLine],
  ['generateFile', RiFileTextLine],
  ['saveUserMemory', RiLightbulbFlashLine],
  ['updateUserPreferences', RiSettings3Line],
  ['updateUserContext', RiUserLine],
]);

/** A tool's glyph; a tool with none of its own reads as the web it reached. */
export function getToolIcon(toolName: string): BloomIconComponent {
  return TOOL_ICONS.get(toolName) ?? RiGlobalLine;
}
