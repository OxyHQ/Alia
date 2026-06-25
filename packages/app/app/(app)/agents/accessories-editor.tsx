import React, { useEffect, useState, useCallback, useMemo } from "react";
import { View, ScrollView, Pressable, Image, Alert } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Check, Lock, RotateCcw, Trash2 } from "lucide-react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAgentsStore, type AgentAccessory } from "@/lib/stores/agents-store";
import { useAccessoriesStore, type CatalogAccessory } from "@/lib/stores/accessories-store";
import { useTranslation } from "@/hooks/useTranslation";
import { useColorScheme } from "@/lib/useColorScheme";
import { toast } from "@/components/sonner";
import { cn } from "@/lib/utils";
import { AliaFace } from "@/components/ui/alia-face";
import { getAccessoryImage } from "@/lib/accessories";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from "react-native-reanimated";
import { errorMessage as getErrorMessage } from '../../../lib/errors/error-utils';

const CANVAS_SIZE = 256;

interface EditorAccessory extends AgentAccessory {
  catalog: CatalogAccessory;
}

export default function AccessoriesEditorScreen() {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const router = useRouter();
  const { agentId } = useLocalSearchParams<{ agentId: string }>();

  const getAgent = useAgentsStore((s) => s.getAgent);
  const updateAgent = useAgentsStore((s) => s.updateAgent);
  const catalog = useAccessoriesStore((s) => s.catalog);
  const loadCatalog = useAccessoriesStore((s) => s.loadCatalog);
  const loadOwned = useAccessoriesStore((s) => s.loadOwned);
  const isOwned = useAccessoriesStore((s) => s.isOwned);
  const purchaseAccessory = useAccessoriesStore((s) => s.purchaseAccessory);

  const [equipped, setEquipped] = useState<EditorAccessory[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeSlot, setActiveSlot] = useState<CatalogAccessory['slot']>("head");

  // Load catalog + owned
  useEffect(() => {
    loadCatalog();
    loadOwned();
  }, [loadCatalog, loadOwned]);

  const catalogBySlug = useMemo(
    () => new Map(catalog.map((c) => [c.slug, c])),
    [catalog]
  );

  // Load agent's current accessories
  useEffect(() => {
    if (!agentId || catalog.length === 0) return;
    getAgent(agentId).then((agent) => {
      if (!agent) return;
      const items: EditorAccessory[] = [];
      for (const acc of agent.accessories ?? []) {
        const catItem = catalogBySlug.get(acc.accessoryId);
        if (catItem) {
          items.push({ accessoryId: acc.accessoryId, position: acc.position, catalog: catItem });
        }
      }
      setEquipped(items);
    });
  }, [agentId, getAgent, catalog, catalogBySlug]);

  const SLOT_ORDER: CatalogAccessory['slot'][] = ['head', 'face', 'neck'];
  const slots = useMemo(
    () => SLOT_ORDER.filter((s) => catalog.some((a) => a.slot === s)),
    [catalog]
  );

  const slotAccessories = useMemo(
    () => catalog.filter((a) => a.slot === activeSlot),
    [catalog, activeSlot]
  );

  const equippedSlugs = useMemo(
    () => new Set(equipped.map((e) => e.accessoryId)),
    [equipped]
  );

  // Indexed list preserving original indices through layer filtering
  const behindItems = useMemo(
    () => equipped.map((e, i) => ({ e, i })).filter(({ e }) => e.catalog.layer === "behind"),
    [equipped]
  );
  const frontItems = useMemo(
    () => equipped.map((e, i) => ({ e, i })).filter(({ e }) => e.catalog.layer === "front"),
    [equipped]
  );

  const addAccessory = useCallback((accessory: CatalogAccessory) => {
    const newEntry: EditorAccessory = {
      // Store slug as the stable accessoryId — registry and rendering use slug
      accessoryId: accessory.slug,
      position: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
      catalog: accessory,
    };
    setEquipped((prev) => {
      setSelectedIdx(prev.length);
      return [...prev, newEntry];
    });
  }, []);

  const handleToggleAccessory = useCallback(
    async (accessory: CatalogAccessory) => {
      const existingIdx = equipped.findIndex((e) => e.accessoryId === accessory.slug);
      if (existingIdx >= 0) {
        setEquipped((prev) => prev.filter((_, i) => i !== existingIdx));
        setSelectedIdx(null);
        return;
      }

      if (!isOwned(accessory._id) && accessory.price > 0) {
        Alert.alert(
          t("accessories.purchase"),
          `${accessory.name} — ${accessory.price} ${t("accessories.credits")}`,
          [
            { text: t("common.cancel"), style: "cancel" },
            {
              text: t("accessories.buy"),
              onPress: async () => {
                try {
                  await purchaseAccessory(accessory._id);
                  toast.success(t("accessories.purchased"));
                  addAccessory(accessory);
                } catch (err: unknown) {
                  toast.error(getErrorMessage(err));
                }
              },
            },
          ]
        );
        return;
      }

      addAccessory(accessory);
    },
    [equipped, isOwned, purchaseAccessory, t, addAccessory]
  );

  const handleRemoveSelected = useCallback(() => {
    if (selectedIdx === null) return;
    setEquipped((prev) => prev.filter((_, i) => i !== selectedIdx));
    setSelectedIdx(null);
  }, [selectedIdx]);

  const handleResetPosition = useCallback(() => {
    if (selectedIdx === null) return;
    setEquipped((prev) =>
      prev.map((e, i) =>
        i === selectedIdx
          ? { ...e, position: { x: 0.5, y: 0.5, scale: 1, rotation: 0 } }
          : e
      )
    );
  }, [selectedIdx]);

  const handlePositionChange = useCallback((idx: number, x: number, y: number) => {
    setEquipped((prev) =>
      prev.map((e, i) =>
        i === idx ? { ...e, position: { ...e.position, x, y } } : e
      )
    );
  }, []);

  const handleSelect = useCallback((idx: number) => {
    setSelectedIdx(idx);
  }, []);

  const handleSave = useCallback(async () => {
    if (!agentId) return;
    setSaving(true);
    try {
      const accessories = equipped.map(({ accessoryId, position }) => ({
        accessoryId,
        position,
      }));
      await updateAgent(agentId, { accessories } as any);
      toast.success(t("common.saved"));
      router.back();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err) || t("common.error"));
    } finally {
      setSaving(false);
    }
  }, [agentId, equipped, updateAgent, t, router]);

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
        <Pressable onPress={() => router.back()} className="active:opacity-70">
          <ArrowLeft size={22} color={colors.foreground} />
        </Pressable>
        <Text className="text-base font-bold text-foreground">
          {t("accessories.editor")}
        </Text>
        <Button
          size="sm"
          className="rounded-full h-8 px-4"
          onPress={handleSave}
          disabled={saving}
        >
          <View className="flex-row items-center gap-1">
            <Check size={14} className="text-primary-foreground" />
            <Text className="text-xs font-semibold text-primary-foreground">
              {saving ? t("common.saving") : t("common.save")}
            </Text>
          </View>
        </Button>
      </View>

      {/* Canvas */}
      <View className="items-center justify-center py-6">
        <View style={{ width: CANVAS_SIZE, height: CANVAS_SIZE, overflow: "visible" }}>
          {/* Behind-layer accessories */}
          {behindItems.map(({ e, i }) => (
            <DraggableAccessory
              key={e.accessoryId}
              entry={e}
              index={i}
              canvasSize={CANVAS_SIZE}
              isSelected={selectedIdx === i}
              selectionColor={colors.primary}
              onSelect={handleSelect}
              onPositionChange={handlePositionChange}
            />
          ))}

          {/* Face */}
          <AliaFace size={CANVAS_SIZE} expression="Idle A" />

          {/* Front-layer accessories */}
          {frontItems.map(({ e, i }) => (
            <DraggableAccessory
              key={e.accessoryId}
              entry={e}
              index={i}
              canvasSize={CANVAS_SIZE}
              isSelected={selectedIdx === i}
              selectionColor={colors.primary}
              onSelect={handleSelect}
              onPositionChange={handlePositionChange}
            />
          ))}
        </View>

        {/* Selected accessory controls */}
        {selectedIdx !== null && (
          <View className="flex-row items-center gap-3 mt-3">
            <Pressable
              onPress={handleResetPosition}
              className="active:opacity-70 bg-muted/70 rounded-full p-2"
            >
              <RotateCcw size={16} color={colors.foreground} />
            </Pressable>
            <Pressable
              onPress={handleRemoveSelected}
              className="active:opacity-70 bg-destructive/10 rounded-full p-2"
            >
              <Trash2 size={16} className="text-destructive" />
            </Pressable>
          </View>
        )}
      </View>

      {/* Slot tabs */}
      <View className="px-4 pb-2">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {slots.map((slot) => (
            <Pressable
              key={slot}
              onPress={() => setActiveSlot(slot)}
              className="active:opacity-70"
            >
              <View
                className={cn(
                  "px-4 py-1.5 rounded-full",
                  activeSlot === slot ? "bg-foreground" : "bg-muted/70"
                )}
              >
                <Text
                  className={cn(
                    "text-xs font-semibold capitalize",
                    activeSlot === slot ? "text-background" : "text-muted-foreground"
                  )}
                >
                  {slot}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Accessory picker */}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
      >
        <View className="flex-row flex-wrap" style={{ margin: -4 }}>
          {slotAccessories.map((accessory) => (
            <AccessoryPickerItem
              key={accessory._id}
              accessory={accessory}
              isEquipped={equippedSlugs.has(accessory.slug)}
              isOwned={isOwned(accessory._id)}
              onPress={() => handleToggleAccessory(accessory)}
              placeholderColor={colors.muted}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ── Draggable accessory on canvas ────────────────────────────────────────────

interface DraggableAccessoryProps {
  entry: EditorAccessory;
  index: number;
  canvasSize: number;
  isSelected: boolean;
  selectionColor: string;
  onSelect: (idx: number) => void;
  onPositionChange: (idx: number, x: number, y: number) => void;
}

const DraggableAccessory = React.memo(function DraggableAccessory({
  entry,
  index,
  canvasSize,
  isSelected,
  selectionColor,
  onSelect,
  onPositionChange,
}: DraggableAccessoryProps) {
  const accImage = getAccessoryImage(entry.accessoryId, entry.catalog.imageUrl);
  const accSize = canvasSize * entry.position.scale;

  const offsetX = useSharedValue((entry.position.x - 0.5) * canvasSize);
  const offsetY = useSharedValue((entry.position.y - 0.5) * canvasSize);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  // Sync shared values when position changes externally (e.g. reset)
  useEffect(() => {
    offsetX.value = withSpring((entry.position.x - 0.5) * canvasSize);
    offsetY.value = withSpring((entry.position.y - 0.5) * canvasSize);
  }, [entry.position.x, entry.position.y, canvasSize]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          runOnJS(onSelect)(index);
          startX.value = offsetX.value;
          startY.value = offsetY.value;
        })
        .onUpdate((e) => {
          offsetX.value = startX.value + e.translationX;
          offsetY.value = startY.value + e.translationY;
        })
        .onEnd(() => {
          const newX = 0.5 + offsetX.value / canvasSize;
          const newY = 0.5 + offsetY.value / canvasSize;
          runOnJS(onPositionChange)(index, newX, newY);
        }),
    [index, canvasSize, onSelect, onPositionChange]
  );

  const tapGesture = useMemo(
    () => Gesture.Tap().onEnd(() => { runOnJS(onSelect)(index); }),
    [index, onSelect]
  );

  const composed = useMemo(
    () => Gesture.Simultaneous(tapGesture, gesture),
    [tapGesture, gesture]
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: offsetX.value },
      { translateY: offsetY.value },
      { rotate: `${entry.position.rotation}deg` },
    ],
  }));

  if (!accImage) return null;

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        style={[
          {
            position: "absolute",
            width: accSize,
            height: accSize,
            top: 0,
            left: 0,
            zIndex: isSelected ? 100 : 1,
          },
          animatedStyle,
        ]}
      >
        <Image
          source={accImage}
          style={{ width: accSize, height: accSize }}
          resizeMode="contain"
        />
        {isSelected && (
          <View
            style={{
              position: "absolute",
              top: -2,
              left: -2,
              right: -2,
              bottom: -2,
              borderWidth: 2,
              borderColor: selectionColor,
              borderRadius: 8,
              borderStyle: "dashed",
            }}
          />
        )}
      </Animated.View>
    </GestureDetector>
  );
});

// ── Picker item ──────────────────────────────────────────────────────────────

interface AccessoryPickerItemProps {
  accessory: CatalogAccessory;
  isEquipped: boolean;
  isOwned: boolean;
  placeholderColor: string;
  onPress: () => void;
}

const AccessoryPickerItem = React.memo(function AccessoryPickerItem({
  accessory,
  isEquipped,
  isOwned,
  placeholderColor,
  onPress,
}: AccessoryPickerItemProps) {
  const accImage = getAccessoryImage(accessory.slug, accessory.imageUrl);

  return (
    <Pressable
      onPress={onPress}
      style={{ width: "25%", padding: 4 }}
      className="active:opacity-70"
    >
      <View
        className={cn(
          "rounded-xl border-2 p-2 items-center",
          isEquipped ? "border-primary bg-primary/10" : "border-transparent bg-muted/50"
        )}
      >
        {accImage ? (
          <Image
            source={accImage}
            style={{ width: 56, height: 56 }}
            resizeMode="contain"
          />
        ) : (
          <View style={{ width: 56, height: 56, backgroundColor: placeholderColor, borderRadius: 8 }} />
        )}

        <Text className="text-[10px] text-foreground font-medium mt-1" numberOfLines={1}>
          {accessory.name}
        </Text>

        {!isOwned && (
          <View className="flex-row items-center gap-0.5 mt-0.5">
            <Lock size={9} className="text-muted-foreground" />
            <Text className="text-[9px] text-muted-foreground">{accessory.price}</Text>
          </View>
        )}

        {isEquipped && (
          <View className="absolute top-1 right-1 bg-primary rounded-full w-4 h-4 items-center justify-center">
            <Check size={10} color="white" />
          </View>
        )}
      </View>
    </Pressable>
  );
});
