import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';
import { generateAPIUrl } from '@/lib/generate-api-url';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useUserData } from '@/lib/hooks/use-user-data';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  SettingsGeneralPage,
  SettingsTextField,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { AlertTriangle, Info, ShieldX } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { SettingsPreferenceSelect } from './preference-select';

interface ThreatEntry {
  id: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'critical';
  agentName: string;
  description: string;
}

interface AuditSummary {
  totalSessions: number;
  completedSessions: number;
  failedSessions: number;
  totalSteps: number;
  threatDetections: number;
}

const TIMEOUT_OPTIONS = [
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
  { value: 120, label: '2min' },
  { value: 0, label: 'Never' },
];

const SEVERITY_COLORS: Record<string, string> = {
  info: 'text-blue-500',
  warning: 'text-yellow-500',
  critical: 'text-red-500',
};

const SEVERITY_BG: Record<string, string> = {
  info: 'bg-blue-500/10',
  warning: 'bg-yellow-500/10',
  critical: 'bg-red-500/10',
};

const SEVERITY_ICONS: Record<string, React.ComponentType<any>> = {
  info: Info,
  warning: AlertTriangle,
  critical: ShieldX,
};

export function SecuritySection() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { memory } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [saving, setSaving] = useState(false);

  const [requireApproval, setRequireApproval] = useState(true);
  const [approvalTimeout, setApprovalTimeout] = useState(60);
  const [autoDenyOnTimeout, setAutoDenyOnTimeout] = useState(true);

  const [threats, setThreats] = useState<ThreatEntry[]>([]);
  const [threatsLoading, setThreatsLoading] = useState(true);

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exporting, setExporting] = useState(false);
  const [summary, setSummary] = useState<AuditSummary | null>(null);

  // Load saved preferences
  useEffect(() => {
    if (memory?.preferences) {
      const sp = memory.preferences.securityPreferences;
      if (sp) {
        if (typeof sp.requireApproval === 'boolean')
          setRequireApproval(sp.requireApproval);
        if (typeof sp.approvalTimeout === 'number')
          setApprovalTimeout(sp.approvalTimeout);
        if (typeof sp.autoDenyOnTimeout === 'boolean')
          setAutoDenyOnTimeout(sp.autoDenyOnTimeout);
      }
    }
  }, [memory]);

  // Load threats
  useEffect(() => {
    loadThreats();
    loadSummary();
  }, []);

  const loadThreats = useCallback(async () => {
    try {
      const res = await apiClient.get(API_ROUTES.audit.threats, {
        params: { limit: 20 },
      });
      setThreats(res.data?.threats || []);
    } catch {
      // silent
    } finally {
      setThreatsLoading(false);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const res = await apiClient.get(API_ROUTES.audit.summary);
      setSummary(res.data);
    } catch {
      // silent
    }
  }, []);

  const handleSave = async () => {
    if (!isAuthenticated) return;
    setSaving(true);
    try {
      const token = oxyServices.getAccessToken();
      const authHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) authHeaders['Authorization'] = `Bearer ${token}`;

      const res = await fetch(generateAPIUrl('/memory/preferences'), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          ...memory?.preferences,
          securityPreferences: {
            requireApproval,
            approvalTimeout,
            autoDenyOnTimeout,
          },
        }),
      });

      if (res.ok) {
        const updated = await res.json();
        setMemory(updated);
        toast.success(t('settings.saveSuccess'));
      } else {
        toast.error(t('settings.saveFailed'));
      }
    } catch {
      toast.error(t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const params: Record<string, string> = { format: exportFormat };
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate;

      const res = await apiClient.get(API_ROUTES.audit.export, { params });

      const content =
        exportFormat === 'json' ? JSON.stringify(res.data, null, 2) : res.data;

      if (Platform.OS === 'web') {
        const blob = new Blob([content], {
          type: exportFormat === 'json' ? 'application/json' : 'text/csv',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `alia-audit-${new Date().toISOString().split('T')[0]}.${exportFormat}`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({
          message: content,
          title: `Alia Audit Export (${exportFormat.toUpperCase()})`,
        });
      }

      toast.success(t('settings.security.exportSuccess'));
    } catch {
      toast.error(t('settings.security.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'approval',
          label: t('settings.security.approvalPreferences'),
          rows: [
            {
              key: 'required',
              label: t('settings.security.requireApproval'),
              description: t('settings.security.requireApprovalDesc'),
              control: (
                <Switch
                  accessibilityLabel={t('settings.security.requireApproval')}
                  value={requireApproval}
                  onValueChange={setRequireApproval}
                />
              ),
            },
            {
              key: 'timeout',
              label: t('settings.security.approvalTimeout'),
              control: (
                <SettingsPreferenceSelect
                  label={t('settings.security.approvalTimeout')}
                  value={String(approvalTimeout)}
                  onChange={(value) => setApprovalTimeout(Number(value))}
                  items={TIMEOUT_OPTIONS.map((option) => ({
                    value: String(option.value),
                    label: option.label,
                  }))}
                />
              ),
            },
            {
              key: 'deny',
              label: t('settings.security.autoDenyOnTimeout'),
              description: t('settings.security.autoDenyOnTimeoutDesc'),
              control: (
                <Switch
                  accessibilityLabel={t('settings.security.autoDenyOnTimeout')}
                  value={autoDenyOnTimeout}
                  onValueChange={setAutoDenyOnTimeout}
                />
              ),
            },
            {
              key: 'save',
              label: t('settings.saveButton'),
              control: (
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={handleSave}
                  disabled={saving}
                >
                  {saving ? t('settings.saving') : t('settings.saveButton')}
                </Button>
              ),
            },
          ],
        },
        {
          key: 'threats',
          label: t('settings.security.threatLog'),
          description: t('settings.security.threatLogDesc'),
          rows: threats.length
            ? threats.slice(0, 10).map((threat) => ({
                key: threat.id,
                label: threat.agentName,
                description: threat.description,
                control: (
                  <View className="gap-1">
                    <Badge
                      tone={
                        threat.severity === 'critical'
                          ? 'danger'
                          : threat.severity === 'warning'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {threat.severity}
                    </Badge>
                    <SettingsValueField>
                      {new Date(threat.timestamp).toLocaleDateString()}
                    </SettingsValueField>
                  </View>
                ),
              }))
            : [
                {
                  key: 'empty',
                  label: threatsLoading
                    ? t('common.loading')
                    : t('settings.security.noThreats'),
                },
              ],
        },
        {
          key: 'export',
          label: t('settings.security.auditExport'),
          description: t('settings.security.auditExportDesc'),
          rows: [
            ...(summary
              ? [
                  {
                    key: 'summary',
                    label: 'Audit summary',
                    description: `${summary.totalSessions} sessions · ${summary.totalSteps} steps · ${summary.threatDetections} threats`,
                  },
                ]
              : []),
            {
              key: 'from',
              label: 'From',
              control: (
                <SettingsTextField
                  label="From date"
                  value={fromDate}
                  onCommit={setFromDate}
                  placeholder="YYYY-MM-DD"
                  showSavedToast={false}
                />
              ),
            },
            {
              key: 'to',
              label: 'To',
              control: (
                <SettingsTextField
                  label="To date"
                  value={toDate}
                  onCommit={setToDate}
                  placeholder="YYYY-MM-DD"
                  showSavedToast={false}
                />
              ),
            },
            {
              key: 'format',
              label: 'Format',
              control: (
                <SettingsPreferenceSelect
                  label="Export format"
                  value={exportFormat}
                  onChange={setExportFormat}
                  items={[
                    { value: 'json', label: 'JSON' },
                    { value: 'csv', label: 'CSV' },
                  ]}
                />
              ),
            },
            {
              key: 'download',
              label: 'Download audit',
              control: (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={exporting}
                  onPress={handleExport}
                >
                  {exporting ? t('common.loading') : 'Export'}
                </Button>
              ),
            },
          ],
        },
      ]}
    />
  );
}
