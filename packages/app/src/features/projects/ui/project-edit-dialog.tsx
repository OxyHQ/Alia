import { useTranslation } from '@/shared/i18n/use-translation';
import type { Project } from '@/features/projects/runtime/projects-store';
import { Chip, ChipRow, type ChipHue } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

/**
 * The colours a project can carry, each drawn as one of Bloom's data hues.
 *
 * The store keeps the hex it always kept (older projects hold one of these),
 * so the value is the hex and the chip is only how it is shown.
 */
const PROJECT_COLORS: readonly { value: string; hue: ChipHue; labelKey: string }[] = [
  { value: '#3b82f6', hue: 'blue', labelKey: 'sidebar.colors.blue' },
  { value: '#8b5cf6', hue: 'purple', labelKey: 'sidebar.colors.purple' },
  { value: '#ec4899', hue: 'rose', labelKey: 'sidebar.colors.rose' },
  { value: '#f59e0b', hue: 'yellow', labelKey: 'sidebar.colors.yellow' },
  { value: '#10b981', hue: 'lime', labelKey: 'sidebar.colors.lime' },
  { value: '#06b6d4', hue: 'cyan', labelKey: 'sidebar.colors.cyan' },
];

const DEFAULT_COLOR = PROJECT_COLORS[0].value;

export interface ProjectEditValues {
  name: string;
  description?: string;
  color: string;
}

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project being edited; `null` creates a new one. */
  project?: Project | null;
  onSave: (values: ProjectEditValues) => void;
}

/** Create or edit a project: its name, an optional description and its colour. */
export function ProjectEditDialog({ open, onOpenChange, project, onSave }: ProjectEditDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
    setColor(project?.color ?? DEFAULT_COLOR);
  }, [project, open]);

  const trimmed = name.trim();
  const save = () => {
    if (!trimmed) return;
    onSave({ name: trimmed, description: description.trim() || undefined, color });
  };

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      placement={{ base: 'bottom', md: 'center' }}
      title={t(project ? 'sidebar.projectDialog.editTitle' : 'sidebar.projectDialog.newTitle')}
      description={t(
        project ? 'sidebar.projectDialog.editDescription' : 'sidebar.projectDialog.newDescription',
      )}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t(project ? 'common.save' : 'common.create'),
          onPress: save,
          disabled: !trimmed,
        },
      ]}
    >
      <View className="gap-4">
        <Field label={t('sidebar.projectDialog.name')} required>
          <TextFieldInput
            label={t('sidebar.projectDialog.name')}
            value={name}
            onValueChange={setName}
            onSubmitEditing={save}
            autoFocus
          />
        </Field>
        <Field label={t('sidebar.projectDialog.description')}>
          <TextFieldInput
            label={t('sidebar.projectDialog.description')}
            value={description}
            onValueChange={setDescription}
          />
        </Field>
        <Field label={t('sidebar.projectDialog.color')} multiple>
          <ChipRow role="radiogroup" accessibilityLabel={t('sidebar.projectDialog.color')}>
            {PROJECT_COLORS.map((option) => {
              const selected = option.value === color;
              return (
                <Chip
                  key={option.value}
                  role="radio"
                  size="xl"
                  hue={option.hue}
                  selected={selected}
                  leadingIcon={selected ? RiCheckLine : undefined}
                  onPress={() => setColor(option.value)}
                >
                  {t(option.labelKey)}
                </Chip>
              );
            })}
          </ChipRow>
        </Field>
      </View>
    </Dialog>
  );
}
