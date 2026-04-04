import { View, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { Switch } from "@/components/ui/switch";
import { useState, useEffect, useCallback } from "react";
import { useOxy } from "@oxyhq/services";
import apiClient from "@/lib/api/client";
import { toast } from "@/components/sonner";
import { Sparkles } from "lucide-react-native";

interface Skill {
  _id: string;
  name: string;
  description?: string;
  enabled: boolean;
}

function SkillRow({
  skill,
  onToggle,
}: {
  skill: Skill;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <View className="flex-row items-center py-3 px-1 border-b border-border">
      <View className="bg-primary/10 p-1.5 rounded-lg mr-3">
        <Sparkles size={18} className="text-primary" />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-medium">{skill.name}</Text>
        {skill.description ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {skill.description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={skill.enabled}
        onValueChange={(val) => onToggle(skill._id, val)}
        size="sm"
      />
    </View>
  );
}

export function SkillsSection() {
  const { isAuthenticated } = useOxy();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSkills = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    try {
      const response = await apiClient.get("/skills");
      setSkills(response.data.skills || []);
    } catch (err) {
      console.error("Failed to fetch skills:", err);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleToggle = async (skillId: string, enabled: boolean) => {
    setSkills((prev) =>
      prev.map((s) => (s._id === skillId ? { ...s, enabled } : s))
    );

    try {
      await apiClient.patch(`/skills/${skillId}`, { enabled });
    } catch (err) {
      console.error("Failed to update skill:", err);
      toast.error("Failed to update skill");
      setSkills((prev) =>
        prev.map((s) => (s._id === skillId ? { ...s, enabled: !enabled } : s))
      );
    }
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-12">
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <Text className="text-xs text-muted-foreground">
        Manage your installed skills. Toggle skills on or off to control what Clarity can do.
      </Text>

      {skills.length === 0 ? (
        <View className="items-center py-10 gap-3">
          <View className="bg-muted/50 p-3 rounded-full">
            <Sparkles size={24} className="text-muted-foreground" />
          </View>
          <Text className="text-sm text-muted-foreground text-center">
            No skills installed yet.
          </Text>
        </View>
      ) : (
        <View>
          {skills.map((skill) => (
            <SkillRow key={skill._id} skill={skill} onToggle={handleToggle} />
          ))}
        </View>
      )}
    </View>
  );
}
