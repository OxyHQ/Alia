import { SkillsCatalogue } from '@/features/skills/ui/skills-catalogue';
import { useRouter } from 'expo-router';
import { useAliaSettings } from './settings-context';

/**
 * The settings dialog's Skills page. A skill's page, import and create open from here, so the
 * dialog closes first: they are pages of their own, not a place under the settings.
 */
export function SkillsSection() {
  const { afterClose } = useAliaSettings();
  const router = useRouter();
  return (
    <SkillsCatalogue
      onOpenSkill={(name) => afterClose(() => router.push(`/(app)/skills/${name}`))}
      onImport={() => afterClose(() => router.push('/(app)/skills/import'))}
      onCreate={() => afterClose(() => router.push('/(app)/skills/create'))}
    />
  );
}
