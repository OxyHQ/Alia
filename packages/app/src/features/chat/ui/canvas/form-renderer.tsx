import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Field } from '@oxy.so/bloom/field';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useState } from 'react';
import { View } from 'react-native';

interface FormField {
  name: string;
  type: 'text' | 'select' | 'checkbox';
  label: string;
  options?: string[];
}

interface FormData {
  fields: FormField[];
}

interface FormRendererProps {
  data: FormData;
  onSubmit?: (formData: Record<string, any>) => void;
}

/** A generated form on Bloom's own controls: `Field` + `TextFieldInput`, `Select`, `Checkbox`. */
export function FormRenderer({ data, onSubmit }: FormRendererProps) {
  const { t } = useTranslation();
  const { fields } = data;
  const [formValues, setFormValues] = useState<Record<string, any>>({});

  const updateValue = (name: string, value: any) => {
    setFormValues((prev) => ({ ...prev, [name]: value }));
  };

  return (
    <View className="gap-4">
      {fields.map((field, i) =>
        field.type === 'checkbox' ? (
          <Checkbox
            key={i}
            label={field.label}
            checked={!!formValues[field.name]}
            onCheckedChange={(v) => updateValue(field.name, v)}
          />
        ) : (
          <Field key={i} label={field.label}>
            {field.type === 'select' ? (
              <Select value={formValues[field.name]} onValueChange={(v) => updateValue(field.name, v)}>
                <SelectTrigger label={field.label}>
                  <SelectValue placeholder={t('panels.form.select')} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent
                  label={field.label}
                  items={(field.options ?? []).map((option) => ({ value: option, label: option }))}
                  valueExtractor={(item) => item.value}
                  renderItem={(item) => (
                    <SelectItem value={item.value} label={item.label}>
                      <SelectItemIndicator />
                      <SelectItemText>{item.label}</SelectItemText>
                    </SelectItem>
                  )}
                />
              </Select>
            ) : (
              <TextFieldInput
                label={field.label}
                value={formValues[field.name] || ''}
                onValueChange={(v) => updateValue(field.name, v)}
                placeholder={t('panels.form.enter', { field: field.label.toLowerCase() })}
              />
            )}
          </Field>
        ),
      )}

      {/* Only a form with somewhere to send its values offers to send them.
          No caller passes `onSubmit` today — the workspace panel renders the
          canvas without a path back into the conversation — and the button
          used to render regardless, a Submit that did nothing (#608, rule 6). */}
      {onSubmit === undefined ? null : (
        <View className="mt-2">
          <Button onPress={() => onSubmit(formValues)}>{t('panels.form.submit')}</Button>
        </View>
      )}
    </View>
  );
}
