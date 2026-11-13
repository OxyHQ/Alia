import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsRowsSkeleton } from '@/shared/ui/skeletons';
import { Button } from '@oxy.so/bloom/button';
import { RiDownload2Line } from '@oxy.so/bloom/icons/RiDownload2Line';
import {
  SettingsGeneralPage,
  SettingsSection,
  SettingsTextField,
  SettingsValueField,
  type SettingsRowData,
} from '@oxy.so/bloom/settings-modal';
import { SettingsSelect } from '@oxy.so/bloom/settings-modal/rows';
import { toast } from '@oxy.so/bloom/toast';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform, Share, View } from 'react-native';

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

  // Queries, so a second visit draws the last threats and summary while they refresh.
  const threatsQuery = useQuery({
    queryKey: queryKeys.audit.threats,
    queryFn: async () => {
      const res = await apiClient.get(API_ROUTES.audit.threats, { params: { limit: 20 } });
      return (res.data?.threats || []) as ThreatEntry[];
    },
  });
  const summaryQuery = useQuery({
    queryKey: queryKeys.audit.summary,
    queryFn: async () => (await apiClient.get(API_ROUTES.audit.summary)).data as AuditSummary,
  });
  const threats = threatsQuery.data ?? [];
  // A failed read shows the empty state, as it did before: only "nothing yet" is a skeleton.
  const threatsLoading = threatsQuery.isPending && !threatsQuery.isError;
  const summary = summaryQuery.data ?? null;

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exporting, setExporting] = useState(false);

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

  const threatRows: SettingsRowData[] = threats.length
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

  const threatsSection = {
    key: 'threats',
    label: t('settings.security.threatLog'),
    description: t('settings.security.threatLogDesc'),
    rows: threatRows,
  };

  const sections = [
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
            <SettingsSelect
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
              {exporting ? t('settings.security.exporting') : t('settings.security.exportButton')}
            </Button>
          ),
        },
      ],
    },
  ];

  // The threat log holds its place as placeholder rows while it is read, under its own heading.
  return threatsLoading ? (
    <View className="w-full gap-6">
      <SettingsSection label={threatsSection.label} description={threatsSection.description}>
        <SettingsRowsSkeleton rows={2} />
      </SettingsSection>
      <SettingsGeneralPage sections={sections} />
    </View>
  ) : (
    <SettingsGeneralPage sections={[threatsSection, ...sections]} />
  );
}
