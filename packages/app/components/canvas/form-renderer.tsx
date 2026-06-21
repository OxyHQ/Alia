import { useState } from 'react';
import { View, TextInput, Pressable } from 'react-native';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ChevronDown } from 'lucide-react-native';
import { Button } from '@/components/ui/button';

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

function SelectField({ field, value, onChange }: { field: FormField; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const options = field.options || [];

  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        className="flex-row items-center justify-between border border-border rounded-lg px-3 py-2.5 bg-background"
      >
        <Text className={`text-sm ${value ? 'text-foreground' : 'text-muted-foreground'}`}>
          {value || 'Select...'}
        </Text>
        <ChevronDown size={16} className="text-muted-foreground" />
      </Pressable>
      {open && (
        <View className="border border-border rounded-lg mt-1 bg-background overflow-hidden">
          {options.map((option, i) => (
            <Pressable
              key={i}
              onPress={() => { onChange(option); setOpen(false); }}
              className={`px-3 py-2.5 ${i > 0 ? 'border-t border-border' : ''} active:bg-muted`}
            >
              <Text className={`text-sm ${value === option ? 'text-primary font-medium' : 'text-foreground'}`}>
                {option}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

export function FormRenderer({ data, onSubmit }: FormRendererProps) {
  const { fields } = data;
  const [formValues, setFormValues] = useState<Record<string, any>>({});

  const updateValue = (name: string, value: any) => {
    setFormValues(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = () => {
    onSubmit?.(formValues);
  };

  return (
    <View className="gap-4">
      {fields.map((field, i) => (
        <View key={i} className="gap-1.5">
          <Text className="text-sm font-medium text-foreground">{field.label}</Text>
          {field.type === 'text' && (
            <TextInput
              value={formValues[field.name] || ''}
              onChangeText={(v) => updateValue(field.name, v)}
              placeholder={`Enter ${field.label.toLowerCase()}`}
              className="border border-border rounded-lg px-3 py-2.5 text-sm text-foreground bg-background"
              placeholderTextColor="#a1a1aa"
            />
          )}
          {field.type === 'select' && (
            <SelectField
              field={field}
              value={formValues[field.name] || ''}
              onChange={(v) => updateValue(field.name, v)}
            />
          )}
          {field.type === 'checkbox' && (
            <View className="flex-row items-center gap-2">
              <Switch
                value={!!formValues[field.name]}
                onValueChange={(v) => updateValue(field.name, v)}
              />
            </View>
          )}
        </View>
      ))}

      <Button onPress={handleSubmit} className="mt-2">
        <Text className="text-sm font-medium text-primary-foreground">Submit</Text>
      </Button>
    </View>
  );
}
