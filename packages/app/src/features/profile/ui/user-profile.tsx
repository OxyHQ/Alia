import { useTranslation } from '@/shared/i18n/use-translation';
import { AiProfileCard } from '@oxy.so/bloom/ai-profile-card';
import { Text } from '@oxy.so/bloom/typography';
import { getAccountDisplayName } from '@oxy.so/core';
import type { User } from '@oxy.so/core';
import { ScrollView, View } from 'react-native';

/** The labels a non-personal account's badge may carry; a person has none. */
const KIND_BADGE = ['organization', 'project', 'channel'] as const;
type KindBadge = (typeof KIND_BADGE)[number];
const badgeOf = (kind: string | undefined): KindBadge | undefined =>
  KIND_BADGE.find((candidate) => candidate === kind);

/**
 * `/@username` for a person: Bloom's AI profile card (cover, picture, name and handle) over what
 * their public Oxy account says of them. The card shows an identity and nothing else: Alia has no
 * activity of a person that is theirs to publish, so no number or heatmap is invented for it.
 */
export function UserProfile({ user }: { user: User }) {
  const { t, locale } = useTranslation();
  const name = getAccountDisplayName(user, locale);
  const kind = badgeOf(user.kind);
  const about = user.bio?.trim() || user.description?.trim() || '';
  return (
    <ScrollView
      contentContainerStyle={{ alignItems: 'center', padding: 16, paddingTop: 72 }}
      testID="user-profile"
    >
      <View style={{ width: '100%', maxWidth: 640, gap: 16 }}>
        <AiProfileCard
          name={name || user.username}
          handle={`@${user.username}`}
          {...(kind === undefined ? {} : { badge: t(`profile.kind.${kind}`) })}
          avatarSource={user.avatar}
          testID="user-profile-card"
        />
        {about === '' ? null : (
          <Text variant="body-regular" testID="user-profile-about">
            {about}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}
