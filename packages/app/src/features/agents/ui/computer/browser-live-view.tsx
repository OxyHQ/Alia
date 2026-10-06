import { useState } from 'react';
import { Image, Pressable, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { Loading } from '@oxy.so/bloom/loading';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Muted, Text } from '@oxy.so/bloom/typography';
import {
  BROWSER_VIEWPORT,
  LIVE_VIEW_KEYS,
  viewportPoint,
  type BrowserController,
  type BrowserInput,
  type BrowserScreenshot,
  type BrowserStatus,
} from '@/features/agents/model/computer';
import { useTranslation } from '@/shared/i18n/use-translation';

/**
 * The agent's browser, live, for the person it works for.
 *
 * Adapted from OpenMuse `apps/server/src/browser-console.ts` (MIT): a
 * screenshot polled every second or two, a press on it becomes a click at the
 * same point of the 1280×800 page, and a text field, a few keys and two scroll
 * buttons do the rest. The page's own code never runs here — this draws a
 * JPEG and sends coordinates.
 *
 * Taking control is how a login or a captcha gets done: the agent's own
 * actions are refused until the person hands it back. Any input from here
 * takes control implicitly (the API acts as the owner), so the button is
 * mostly a statement of intent — and "hand back" is the important one.
 */
export function BrowserLiveView({
  browser,
  screenshot,
  screenshotFailed,
  busy,
  error,
  onInput,
  onControl,
  onNavigate,
  onOpen,
}: {
  browser: BrowserStatus;
  screenshot: BrowserScreenshot | undefined;
  screenshotFailed: boolean;
  busy: boolean;
  error: string | null;
  onInput: (input: BrowserInput) => void;
  onControl: (controller: BrowserController) => void;
  onNavigate: (url: string) => void;
  onOpen: (url?: string) => void;
}) {
  const { t } = useTranslation();
  const [drawn, setDrawn] = useState({ width: 0, height: 0 });
  const [text, setText] = useState('');
  const [address, setAddress] = useState('');
  const open = browser.state === 'open';
  const owner = browser.controller === 'owner';

  const submitAddress = () => {
    const url = address.trim();
    if (!url) return;
    const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    if (open) onNavigate(full);
    else onOpen(full);
    setAddress('');
  };

  const press = (event: GestureResponderEvent) => {
    const point = viewportPoint({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, drawn);
    if (point && !busy) onInput({ type: 'click', ...point });
  };

  const sendText = () => {
    if (!text || busy) return;
    onInput({ type: 'type', text });
    setText('');
  };

  if (!open) {
    return (
      <View className="gap-3 rounded-2xl bg-surface-subtle p-4" testID="browser-closed">
        <Text variant="body-medium">{t('agents.computer.browser.closed')}</Text>
        <Muted>{t('agents.computer.browser.closedHint')}</Muted>
        <View className="flex-row items-end gap-2">
          <View className="flex-1">
            <TextFieldInput
              label={t('agents.computer.browser.urlLabel')}
              placeholder={t('agents.computer.browser.urlPlaceholder')}
              value={address}
              onChangeText={setAddress}
              onSubmitEditing={submitAddress}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
          <Button tone="accent" leadingIcon={RiGlobalLine} disabled={busy} onPress={() => (address.trim() ? submitAddress() : onOpen())}>
            {t('agents.computer.browser.openButton')}
          </Button>
        </View>
        {error ? <Text variant="body-regular" testID="browser-error">{error}</Text> : null}
      </View>
    );
  }

  return (
    <View className="gap-3" testID="browser-live">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Chip size="large">{owner ? t('agents.computer.browser.youInControl') : t('agents.computer.browser.agentInControl')}</Chip>
        {owner ? (
          <Button tone="accent" disabled={busy} onPress={() => onControl('agent')} testID="hand-back">
            {t('agents.computer.browser.handBack')}
          </Button>
        ) : (
          <Button tone="neutral" appearance="outline" disabled={busy} onPress={() => onControl('owner')} testID="take-control">
            {t('agents.computer.browser.takeControl')}
          </Button>
        )}
      </View>
      {!owner ? <Muted>{t('agents.computer.browser.takeControlHint')}</Muted> : null}

      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextFieldInput
            label={t('agents.computer.browser.urlLabel')}
            placeholder={browser.url || t('agents.computer.browser.urlPlaceholder')}
            value={address}
            onChangeText={setAddress}
            onSubmitEditing={submitAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
        <Button tone="neutral" appearance="outline" disabled={busy || !address.trim()} onPress={submitAddress}>
          {t('agents.computer.browser.go')}
        </Button>
      </View>

      <Pressable
        accessibilityRole="image"
        accessibilityLabel={t('agents.computer.browser.screenLabel')}
        onPress={press}
        onLayout={(event: LayoutChangeEvent) => setDrawn(event.nativeEvent.layout)}
        disabled={busy || !screenshot}
        testID="browser-screen"
        style={{ width: '100%', aspectRatio: BROWSER_VIEWPORT.width / BROWSER_VIEWPORT.height, opacity: busy ? 0.6 : 1 }}
        className="overflow-hidden rounded-xl bg-surface-subtle"
      >
        {screenshot ? (
          <Image
            source={{ uri: `data:${screenshot.mimeType};base64,${screenshot.data}` }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="contain"
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <Loading variant="spinner" text={t('agents.computer.browser.loading')} />
          </View>
        )}
      </Pressable>
      {screenshotFailed ? <Muted>{t('agents.computer.browser.disconnected')}</Muted> : null}
      {error ? <Text variant="body-regular" testID="browser-error">{error}</Text> : null}

      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextFieldInput
            label={t('agents.computer.browser.typeLabel')}
            placeholder={t('agents.computer.browser.typePlaceholder')}
            value={text}
            onChangeText={setText}
            onSubmitEditing={sendText}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={2000}
          />
        </View>
        <Button tone="accent" disabled={busy || !text} onPress={sendText} testID="send-text">
          {t('agents.computer.browser.send')}
        </Button>
      </View>

      <View className="flex-row flex-wrap gap-2">
        {LIVE_VIEW_KEYS.map((key) => (
          <Button key={key} size="sm" tone="neutral" appearance="outline" disabled={busy} onPress={() => onInput({ type: 'key', key })}>
            {t(`agents.computer.browser.keys.${key}`)}
          </Button>
        ))}
        <Button size="sm" tone="neutral" appearance="outline" leadingIcon={RiArrowUpLine} disabled={busy} onPress={() => onInput({ type: 'scroll', deltaY: -600 })}>
          {t('agents.computer.browser.scrollUp')}
        </Button>
        <Button size="sm" tone="neutral" appearance="outline" leadingIcon={RiArrowDownLine} disabled={busy} onPress={() => onInput({ type: 'scroll', deltaY: 600 })}>
          {t('agents.computer.browser.scrollDown')}
        </Button>
      </View>
    </View>
  );
}
