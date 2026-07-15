import { View } from 'react-native';
import { useTranslation } from '@/lib/hooks/use-translation';
import { SectionLabel } from './section-label';
import { BulletList } from './bullet-list';

interface GoodAtNotForProps {
  goodAt?: string[];
  notGoodAt?: string[];
}

export function GoodAtNotFor({ goodAt, notGoodAt }: GoodAtNotForProps) {
  if ((!goodAt || goodAt.length === 0) && (!notGoodAt || notGoodAt.length === 0)) return null;

  const { t } = useTranslation();

  return (
    <View className="flex-row gap-5 mb-5">
      {goodAt && goodAt.length > 0 && (
        <View className="flex-1">
          <SectionLabel>{t('roles.goodAt')}</SectionLabel>
          <BulletList items={goodAt} color="green" />
        </View>
      )}
      {notGoodAt && notGoodAt.length > 0 && (
        <View className="flex-1">
          <SectionLabel>{t('roles.notFor')}</SectionLabel>
          <BulletList items={notGoodAt} color="orange" muted />
        </View>
      )}
    </View>
  );
}
