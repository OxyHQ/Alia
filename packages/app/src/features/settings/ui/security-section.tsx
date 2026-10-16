import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiDownload2Line } from '@oxy.so/bloom/icons/RiDownload2Line';
import {
  SettingsGeneralPage,
  SettingsTextField,
  SettingsValueField,
  type SettingsRowData,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Share } from 'react-native';
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

export function SecuritySection() {
  const { t } = useTranslation();

  const [threats, setThreats] = useState<ThreatEntry[]>([]);
  const [threatsLoading, setThreatsLoading] = useState(true);

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exporting, setExporting] = useState(false);
  const [summary, setSummary] = useState<AuditSummary | null>(null);

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

  const handleExport = async () => {
    setExporting(true);
    try {
      const params: Record<string, string> = { format: exportFormat };
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate;

      const res = await apiClient.get(API_ROUTES.audit.export, { params });

      const content = exportFormat === 'json' ? JSON.stringify(res.data, null, 2) : res.data;

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
          title: t('settings.security.exportShareTitle', {
            format: exportFormat.toUpperCase(),
          }),
        });
      }

      toast.success(t('settings.security.exportSuccess'));
    } catch {
      toast.error(t('settings.security.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const threatRows: SettingsRowData[] = threatsLoading
    ? [
        {
          key: 'loading',
          label: t('common.loading'),
          control: <Skeleton.Box width={202} height={32} borderRadius={10} />,
        },
      ]
    : threats.length
      ? threats.slice(0, 10).map((threat) => ({
          key: threat.id,
          label: threat.agentName,
          description: `${t(`settings.account.security.severity.${threat.severity}`)} · ${threat.description}`,
          control: (
            <SettingsValueField muted>
              {new Date(threat.timestamp).toLocaleDateString()}
            </SettingsValueField>
          ),
        }))
      : [{ key: 'empty', label: t('settings.security.noThreats') }];

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'threats',
          label: t('settings.security.threatLog'),
          description: t('settings.security.threatLogDesc'),
          rows: threatRows,
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
                    label: t('settings.account.security.auditSummary'),
                    description: t('settings.account.security.auditSummaryDetail', {
                      sessions: summary.totalSessions,
                      steps: summary.totalSteps,
                      threats: summary.threatDetections,
                    }),
                  },
                ]
              : []),
            {
              key: 'from',
              label: t('settings.security.from'),
              control: (
                <SettingsTextField
                  label={t('settings.account.security.fromDate')}
                  value={fromDate}
                  onCommit={setFromDate}
                  placeholder="YYYY-MM-DD"
                  showSavedToast={false}
                />
              ),
            },
            {
              key: 'to',
              label: t('settings.security.to'),
              control: (
                <SettingsTextField
                  label={t('settings.account.security.toDate')}
                  value={toDate}
                  onCommit={setToDate}
                  placeholder="YYYY-MM-DD"
                  showSavedToast={false}
                />
              ),
            },
            {
              key: 'format',
              label: t('settings.security.format'),
              control: (
                <SettingsPreferenceSelect
                  label={t('settings.account.security.exportFormat')}
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
              label: t('settings.account.security.downloadAudit'),
              control: (
                <Button
                  size="sm"
                  leadingIcon={RiDownload2Line}
                  appearance="outline"
                  tone="neutral"
                  disabled={exporting}
                  loading={exporting}
                  onPress={handleExport}
                >
                  {exporting
                    ? t('settings.security.exporting')
                    : t('settings.security.exportButton')}
                </Button>
              ),
            },
          ],
        },
      ]}
    />
  );
}
