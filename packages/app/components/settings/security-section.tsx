import { View, Pressable, TextInput as RNTextInput, FlatList, Share, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useState, useEffect, useCallback } from "react";
import { useOxy } from "@oxyhq/services";
import { generateAPIUrl } from "@/lib/generate-api-url";
import {
  ShieldAlert,
  ShieldX,
  ShieldCheck,
  Clock,
  ChevronDown,
  AlertTriangle,
  Info,
} from "lucide-react-native";
import {
  AgentPermissionToggles,
  DEFAULT_PERMISSIONS,
} from "@/components/agent-permission-toggles";
import type { AgentPermissions } from "@/lib/stores/agents-store";
import { useUserData } from "@/lib/hooks/use-user-data";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/lib/hooks/use-translation";
import { toast } from "@oxyhq/bloom/toast";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import { useTheme } from "@oxyhq/bloom/theme";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";

interface ThreatEntry {
  id: string;
  timestamp: string;
  severity: "info" | "warning" | "critical";
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
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
  { value: 120, label: "2min" },
  { value: 0, label: "Never" },
];

const SEVERITY_COLORS: Record<string, string> = {
  info: "text-blue-500",
  warning: "text-yellow-500",
  critical: "text-red-500",
};

const SEVERITY_BG: Record<string, string> = {
  info: "bg-blue-500/10",
  warning: "bg-yellow-500/10",
  critical: "bg-red-500/10",
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

  const [permissions, setPermissions] = useState<AgentPermissions>({ ...DEFAULT_PERMISSIONS });

  const [requireApproval, setRequireApproval] = useState(true);
  const [approvalTimeout, setApprovalTimeout] = useState(60);
  const [autoDenyOnTimeout, setAutoDenyOnTimeout] = useState(true);

  const [threats, setThreats] = useState<ThreatEntry[]>([]);
  const [threatsLoading, setThreatsLoading] = useState(true);

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [exportFormat, setExportFormat] = useState<"json" | "csv">("json");
  const [exporting, setExporting] = useState(false);
  const [summary, setSummary] = useState<AuditSummary | null>(null);

  // Load saved preferences
  useEffect(() => {
    if (memory?.preferences) {
      const dp = memory.preferences.defaultAgentPermissions;
      if (dp) setPermissions(dp as unknown as AgentPermissions);

      const sp = memory.preferences.securityPreferences;
      if (sp) {
        if (typeof sp.requireApproval === "boolean") setRequireApproval(sp.requireApproval);
        if (typeof sp.approvalTimeout === "number") setApprovalTimeout(sp.approvalTimeout);
        if (typeof sp.autoDenyOnTimeout === "boolean") setAutoDenyOnTimeout(sp.autoDenyOnTimeout);
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
      const res = await apiClient.get(API_ROUTES.audit.threats, { params: { limit: 20 } });
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
      const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (token) authHeaders["Authorization"] = `Bearer ${token}`;

      const res = await fetch(generateAPIUrl("/memory/preferences"), {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          ...memory?.preferences,
          defaultAgentPermissions: permissions,
          securityPreferences: { requireApproval, approvalTimeout, autoDenyOnTimeout },
        }),
      });

      if (res.ok) {
        const updated = await res.json();
        setMemory(updated);
        toast.success(t("settings.saveSuccess"));
      } else {
        toast.error(t("settings.saveFailed"));
      }
    } catch {
      toast.error(t("settings.saveFailed"));
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

      const content = exportFormat === "json"
        ? JSON.stringify(res.data, null, 2)
        : res.data;

      if (Platform.OS === "web") {
        const blob = new Blob([content], {
          type: exportFormat === "json" ? "application/json" : "text/csv",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `alia-audit-${new Date().toISOString().split("T")[0]}.${exportFormat}`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({
          message: content,
          title: `Alia Audit Export (${exportFormat.toUpperCase()})`,
        });
      }

      toast.success(t("settings.security.exportSuccess"));
    } catch {
      toast.error(t("settings.security.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const inputClass = "border border-border rounded-lg px-3 py-2 bg-background text-foreground text-sm";

  return (
    <View className="gap-8">
      <SettingsListGroup
        title={t("settings.security.defaultPermissions")}
        footer={t("settings.security.defaultPermissionsDesc")}
      >
        <View className="p-3">
          <AgentPermissionToggles permissions={permissions} onChange={setPermissions} />
        </View>
      </SettingsListGroup>

      {/* Section B: Approval Preferences */}
      <SettingsListGroup title={t("settings.security.approvalPreferences")}>
        <SettingsListItem
          icon={<ShieldAlert size={18} color={colors.textSecondary} />}
          title={t("settings.security.requireApproval")}
          description={t("settings.security.requireApprovalDesc")}
          rightElement={<Switch value={requireApproval} onValueChange={setRequireApproval} />}
        />
        <SettingsListItem
          icon={<Clock size={18} color={colors.textSecondary} />}
          title={t("settings.security.approvalTimeout")}
          rightElement={
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Pressable className="flex-row items-center gap-1 border border-border rounded-lg px-3 py-1.5">
                  <Text className="text-sm text-foreground">
                    {TIMEOUT_OPTIONS.find(o => o.value === approvalTimeout)?.label || "60s"}
                  </Text>
                  <ChevronDown size={14} className="text-muted-foreground" />
                </Pressable>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {TIMEOUT_OPTIONS.map((opt) => (
                  <DropdownMenu.CheckboxItem
                    key={String(opt.value)}
                    value={approvalTimeout === opt.value ? "on" : "off"}
                    onValueChange={() => setApprovalTimeout(opt.value)}
                  >
                    <DropdownMenu.ItemIndicator />
                    <DropdownMenu.ItemTitle>{opt.label}</DropdownMenu.ItemTitle>
                  </DropdownMenu.CheckboxItem>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          }
        />
        <SettingsListItem
          icon={<ShieldX size={18} color={colors.textSecondary} />}
          title={t("settings.security.autoDenyOnTimeout")}
          description={t("settings.security.autoDenyOnTimeoutDesc")}
          rightElement={<Switch value={autoDenyOnTimeout} onValueChange={setAutoDenyOnTimeout} />}
        />
      </SettingsListGroup>

      <SettingsListGroup
        title={t("settings.security.threatLog")}
        footer={t("settings.security.threatLogDesc")}
      >
        {threats.length === 0 ? (
          <View className="items-center py-8 gap-2">
            <ShieldCheck size={32} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground">
              {t("settings.security.noThreats")}
            </Text>
          </View>
        ) : (
          <View className="gap-2">
            {threats.slice(0, 10).map((threat) => {
              const SevIcon = SEVERITY_ICONS[threat.severity] || Info;
              return (
                <View
                  key={threat.id}
                  className={`flex-row items-start gap-2 p-3 rounded-lg ${SEVERITY_BG[threat.severity] || "bg-muted"}`}
                >
                  <SevIcon size={14} className={`mt-0.5 ${SEVERITY_COLORS[threat.severity]}`} />
                  <View className="flex-1">
                    <View className="flex-row items-center justify-between">
                      <Text className={`text-xs font-semibold uppercase ${SEVERITY_COLORS[threat.severity]}`}>
                        {threat.severity}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {new Date(threat.timestamp).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text className="text-xs text-muted-foreground mt-0.5">
                      {threat.agentName}
                    </Text>
                    <Text className="text-sm text-foreground mt-1" numberOfLines={2}>
                      {threat.description}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </SettingsListGroup>

      <SettingsListGroup
        title={t("settings.security.auditExport")}
        footer={t("settings.security.auditExportDesc")}
      >
       <View className="p-3 gap-3">

        {summary && (
          <View className="flex-row gap-4 py-2">
            <View>
              <Text className="text-lg font-bold text-foreground">{summary.totalSessions}</Text>
              <Text className="text-xs text-muted-foreground">Sessions</Text>
            </View>
            <View>
              <Text className="text-lg font-bold text-foreground">{summary.totalSteps}</Text>
              <Text className="text-xs text-muted-foreground">Steps</Text>
            </View>
            <View>
              <Text className="text-lg font-bold text-foreground">{summary.threatDetections}</Text>
              <Text className="text-xs text-muted-foreground">Threats</Text>
            </View>
          </View>
        )}

        <View className="flex-row gap-2">
          <View className="flex-1 gap-1">
            <Text className="text-xs text-muted-foreground">{t("settings.security.from")}</Text>
            <RNTextInput
              className={inputClass}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textSecondary}
              value={fromDate}
              onChangeText={setFromDate}
            />
          </View>
          <View className="flex-1 gap-1">
            <Text className="text-xs text-muted-foreground">{t("settings.security.to")}</Text>
            <RNTextInput
              className={inputClass}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textSecondary}
              value={toDate}
              onChangeText={setToDate}
            />
          </View>
        </View>

        <View className="flex-row gap-2">
          <Text className="text-xs text-muted-foreground self-center">{t("settings.security.format")}:</Text>
          <Pressable
            onPress={() => setExportFormat("json")}
            className={`px-3 py-1.5 rounded-lg border ${exportFormat === "json" ? "border-primary bg-primary/10" : "border-border"}`}
          >
            <Text className={`text-sm ${exportFormat === "json" ? "text-primary font-medium" : "text-muted-foreground"}`}>
              JSON
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setExportFormat("csv")}
            className={`px-3 py-1.5 rounded-lg border ${exportFormat === "csv" ? "border-primary bg-primary/10" : "border-border"}`}
          >
            <Text className={`text-sm ${exportFormat === "csv" ? "text-primary font-medium" : "text-muted-foreground"}`}>
              CSV
            </Text>
          </Pressable>
        </View>

        <Button onPress={handleExport} disabled={exporting}>
          <Text>{exporting ? t("settings.security.exporting") : t("settings.security.exportButton")}</Text>
        </Button>
       </View>
      </SettingsListGroup>

      {/* Save / Cancel */}
      <View className="flex-row gap-2 mt-2">
        <Button variant="outline" className="flex-1" onPress={() => {
          if (memory?.preferences) {
            const dp = memory.preferences.defaultAgentPermissions;
            if (dp) setPermissions(dp as unknown as AgentPermissions);
            const sp = memory.preferences.securityPreferences;
            if (sp) {
              if (typeof sp.requireApproval === "boolean") setRequireApproval(sp.requireApproval);
              if (typeof sp.approvalTimeout === "number") setApprovalTimeout(sp.approvalTimeout);
              if (typeof sp.autoDenyOnTimeout === "boolean") setAutoDenyOnTimeout(sp.autoDenyOnTimeout);
            }
          }
        }} disabled={saving}>
          <Text>{t("common.cancel")}</Text>
        </Button>
        <Button className="flex-1" onPress={handleSave} disabled={saving}>
          <Text>{saving ? t("settings.saving") : t("settings.saveButton")}</Text>
        </Button>
      </View>
    </View>
  );
}
