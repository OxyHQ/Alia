import { useCallback, useMemo } from "react";
import { Image } from "@/shared/ui/image";
import { RiCameraLine } from "@oxy.so/bloom/icons/RiCameraLine";
import { RiImageLine } from "@oxy.so/bloom/icons/RiImageLine";
import { RiAttachment2 } from "@oxy.so/bloom/icons/RiAttachment2";
import { RiEarthLine } from "@oxy.so/bloom/icons/RiEarthLine";
import { RiEyeOffLine } from "@oxy.so/bloom/icons/RiEyeOffLine";
import { RiPencilLine } from "@oxy.so/bloom/icons/RiPencilLine";
import { RiBookOpenLine } from "@oxy.so/bloom/icons/RiBookOpenLine";
import { RiPlugLine } from "@oxy.so/bloom/icons/RiPlugLine";
import { RiPushpinLine } from "@oxy.so/bloom/icons/RiPushpinLine";
import { RiSearchLine } from "@oxy.so/bloom/icons/RiSearchLine";
import type { ComposerPanelAddMenuGroup } from "@oxy.so/bloom/composer-panel";
import { ActionKeyIcon } from "@/shared/ui/action-key-icon";
import { useImagePicker, type ImagePickerAsset } from "@/shared/platform/use-image-picker";
import { useDocumentPicker } from "@/shared/platform/use-document-picker";
import { useTranslation } from "@/shared/i18n/use-translation";
import type { TurnSelectionOptions } from "@/features/chat/model/turn-selection";
import type { Attachment } from "./types";

/**
 * The plus button's menu, as DATA.
 *
 * Alia's own add menu was a `DropdownMenu` tree whose rows each closed over a
 * picker, a toast and a store; Bloom's `AddMenu` takes
 * `ComposerPanelAddMenuGroup[]` — a label and rows of
 * `{ id, label, description?, icon?, checked? }` — and reports the pressed
 * row's id through `onAddMenuSelect`. So the rows stop being components and
 * become a list, and the behaviour behind each one moves into the one switch
 * at the bottom of this file.
 *
 * ## `checked` is why this is possible at all
 *
 * More than half of Alia's rows are SWITCHES, not actions: web search, deep
 * research, ghost, agent, every installed skill and every connected app are all
 * things that are on or off for the next turn, and the composer is where their
 * state is read. A row that cannot draw its own state turns every one of them
 * into a button that looks identical whether it did something or undid it —
 * which is precisely why the first attempt at this adoption stopped. `checked`
 * draws a tick when the switch is on and holds the same 18px empty when it is
 * off, so on and off are one glance apart and a row that has been turned off
 * still occupies the shape of a row that could be turned on. A row that OMITS
 * `checked` draws no tick column at all, which is how an action tells itself
 * apart from a switch that happens to be off.
 *
 * ## What the groups are for
 *
 * `ComposerPanelAddMenuGroup` is a heading plus rows, which is exactly the
 * `Separator` + `Label` pairs the old menu drew by hand — including the bug it
 * drew them into, where the skills block was nested inside the connectors'
 * condition and an account with skills and no running MCP server was shown
 * none of them. A group is present when its own rows are, and `groups` is built
 * from four independent pushes for that reason.
 *
 * Bloom keys a group by its LABEL, so the labels have to be distinct and
 * non-empty. They are translated, which is the same requirement in a second
 * language.
 */

/** The row ids, namespaced so two groups can never collide over one word. */
const ROW = {
  camera: "add:camera",
  photos: "add:photos",
  files: "add:files",
  webSearch: "cap:web-search",
  deepResearch: "cap:deep-research",
  pinModel: "cap:pin-model",
  ghost: "cap:ghost",
  canvas: "cap:canvas",
} as const;

const SKILL_PREFIX = "skill:";
const CONNECTOR_PREFIX = "connector:";

/**
 * A connector's own mark, at the 24px a Bloom row gives `image`.
 *
 * `image` rather than `icon` because `icon` is a Bloom icon COMPONENT and a
 * connector's is a URL the server published — there is no component to hand
 * over, only artwork to draw.
 */
function ConnectorMark({ icon }: { icon?: string }) {
  if (icon !== undefined && /^https?:\/\//i.test(icon)) {
    return (
      <Image source={{ uri: icon }} className="h-6 w-6" contentFit="contain" />
    );
  }
  return <ActionKeyIcon width={24} />;
}

export interface ComposerAddMenuOptions {
  /** A picked file becomes an attachment. The composer owns the list. */
  addAttachment: (attachment: Attachment) => void;
  /**
   * Whether a file can be attached to the next turn at all.
   *
   * False while an answer streams or the usage limit has closed the composer,
   * and the three picker rows are withheld when it is — the same lock the old
   * add-menu button carried, aimed at the rows that need it.
   *
   * The capability rows are NOT withheld with them, and that is a deliberate
   * narrowing. The old button was disabled as a whole, so a stream took the
   * toggles away too; but a toggle applies to the NEXT turn, so changing one
   * while an answer streams is harmless — which is the argument
   * `model-selector.tsx` already made for the model chip, in those words, and
   * declined to make for the menu beside it only because a `DropdownMenu` has
   * one trigger and one disabled state to give it.
   */
  canAttach: boolean;
  /** The three persistent capability axes, as they stand. */
  modes: { ghost: boolean; agent: boolean; deepResearch: boolean };
  toggleMode: (mode: "ghost" | "agent" | "deepResearch") => void;
  webSearch: boolean;
  onToggleWebSearch: () => void;
  onOpenCanvas: () => void;
  /**
   * Ghost mode is offered on an empty conversation only — it decides whether
   * what you are about to start gets saved, and a stretch already on screen
   * has been saved.
   */
  offerGhost: boolean;
  /**
   * The chosen model, for the row that pins it to the top of the picker —
   * Bloom's picker has no per-row action of its own. `null` hides the row.
   */
  pinModel?: { name: string; pinned: boolean; onToggle: () => void } | null;
  /** Skills and apps for THIS turn, already resolved into two lists. */
  turnSelection: TurnSelectionOptions;
  onToggleSkill: (name: string) => void;
  onToggleConnector: (id: string) => void;
}

export interface ComposerAddMenu {
  groups: readonly ComposerPanelAddMenuGroup[];
  onSelect: (rowId: string) => void;
}

export function useComposerAddMenu(options: ComposerAddMenuOptions): ComposerAddMenu {
  const { t } = useTranslation();
  const { pickImage, takePhoto } = useImagePicker();
  const { pickDocument } = useDocumentPicker();

  const {
    addAttachment,
    canAttach,
    modes,
    toggleMode,
    webSearch,
    onToggleWebSearch,
    onOpenCanvas,
    offerGhost,
    pinModel = null,
    turnSelection,
    onToggleSkill,
    onToggleConnector,
  } = options;

  const groups = useMemo<ComposerPanelAddMenuGroup[]>(() => {
    const built: ComposerPanelAddMenuGroup[] = [];
    // The template's two groups: "Add" (attachments, then rows with a
    // description) and a second group of 24px rows with a description each.
    built.push(
      {
        label: t("composer.addGroup"),
        rows: [
          ...(canAttach
            ? [
                { id: ROW.camera, label: t("composer.camera"), icon: RiCameraLine },
                { id: ROW.photos, label: t("composer.photos"), icon: RiImageLine },
                { id: ROW.files, label: t("composer.files"), icon: RiAttachment2 },
              ]
            : []),
          {
            id: ROW.webSearch,
            label: t("modes.searchLabel"),
            description: t("composer.searchDescription"),
            icon: RiEarthLine,
            checked: webSearch,
          },
          // A tool the turn may use, on the model the picker shows — not a
          // model and not a mode.
          {
            id: ROW.deepResearch,
            label: t("modes.deepResearchLabel"),
            description: t("composer.deepResearchDescription"),
            icon: RiSearchLine,
            checked: modes.deepResearch,
          },
        ],
      },
      {
        label: t("composer.capabilitiesGroup"),
        rows: [
          ...(offerGhost
            ? [
                {
                  id: ROW.ghost,
                  label: t("modes.ghostLabel"),
                  description: t("composer.ghostDescription"),
                  icon: RiEyeOffLine,
                  iconSize: 24 as const,
                  checked: modes.ghost,
                },
              ]
            : []),
          // Canvas OPENS a panel; it is not on or off, so it carries no
          // `checked` at all.
          {
            id: ROW.canvas,
            label: t("composer.canvas"),
            description: t("composer.canvasDescription"),
            icon: RiPencilLine,
            iconSize: 24 as const,
          },
          ...(pinModel !== null
            ? [
                {
                  id: ROW.pinModel,
                  label: t("composer.pinModel"),
                  description: pinModel.name,
                  icon: RiPushpinLine,
                  iconSize: 24 as const,
                  checked: pinModel.pinned,
                },
              ]
            : []),
        ],
      },
    );

    if (turnSelection.skills.length > 0) {
      built.push({
        label: t("skills.composerLabel"),
        rows: turnSelection.skills.map((skill) => ({
          id: `${SKILL_PREFIX}${skill.name}`,
          label: skill.label,
          description: skill.description,
          icon: RiBookOpenLine,
          checked: skill.selected,
        })),
      });
    }

    if (turnSelection.connectors.length > 0) {
      built.push({
        label: t("composer.appsGroup"),
        rows: turnSelection.connectors.map((connector) => ({
          id: `${CONNECTOR_PREFIX}${connector.id}`,
          label: connector.label,
          description: t("composer.connectorTools", { count: connector.toolCount }),
          image:
            connector.icon === undefined ? (
              <RiPlugLine width={24} height={24} />
            ) : (
              <ConnectorMark icon={connector.icon} />
            ),
          checked: connector.selected,
        })),
      });
    }

    return built;
  }, [t, canAttach, webSearch, modes, offerGhost, pinModel, turnSelection]);

  const addImages = useCallback(
    (assets: ImagePickerAsset[] | undefined) => {
      assets?.forEach((asset) => {
        addAttachment({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          uri: asset.uri,
          type: "image",
          name: asset.name,
          size: asset.size,
          mimeType: asset.mimeType,
        });
      });
    },
    [addAttachment],
  );

  const onSelect = useCallback(
    (rowId: string) => {
      if (rowId.startsWith(SKILL_PREFIX)) {
        onToggleSkill(rowId.slice(SKILL_PREFIX.length));
        return;
      }
      if (rowId.startsWith(CONNECTOR_PREFIX)) {
        onToggleConnector(rowId.slice(CONNECTOR_PREFIX.length));
        return;
      }
      switch (rowId) {
        // Asked again on the way IN, not only on the way out. A row withheld
        // from the menu is a row nobody can press — until a menu left open
        // across the start of a stream is pressed a moment later, which is a
        // gesture that reaches a list this build no longer draws.
        case ROW.camera:
          if (!canAttach) return;
          void takePhoto().then(addImages);
          return;
        case ROW.photos:
          if (!canAttach) return;
          void pickImage().then(addImages);
          return;
        case ROW.files:
          if (!canAttach) return;
          void pickDocument().then((docs) => {
            docs?.forEach((doc) => {
              addAttachment({
                id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                uri: doc.uri,
                type: "document",
                name: doc.name,
                size: doc.size,
                mimeType: doc.mimeType,
              });
            });
          });
          return;
        case ROW.webSearch:
          onToggleWebSearch();
          return;
        case ROW.deepResearch:
          toggleMode("deepResearch");
          return;
        case ROW.pinModel:
          pinModel?.onToggle();
          return;
        case ROW.ghost:
          toggleMode("ghost");
          return;
        case ROW.canvas:
          onOpenCanvas();
          return;
        default:
          // A row id from a menu this build did not produce. Doing nothing is
          // the only safe reading: every branch above performs something
          // irreversible-ish, and guessing which one was meant is worse than
          // a press that did not land.
          return;
      }
    },
    [
      addAttachment,
      addImages,
      canAttach,
      onOpenCanvas,
      onToggleConnector,
      onToggleSkill,
      onToggleWebSearch,
      pickDocument,
      pinModel,
      pickImage,
      takePhoto,
      toggleMode,
    ],
  );

  return { groups, onSelect };
}
